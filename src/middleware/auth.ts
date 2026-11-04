import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { staffExists } from '../db/staff';

// Signs dashboard logins. Never fall back to a fixed string: this code is public,
// so anyone could forge an admin login with it. Without JWT_SECRET a random secret
// is used instead, which signs everyone out whenever the server restarts.
export const JWT_SECRET = process.env.JWT_SECRET || randomSecret();

function randomSecret(): string {
    console.warn('JWT_SECRET is not set in .env, so dashboard logins will reset whenever the server restarts.');
    return crypto.randomBytes(32).toString('hex');
}

export interface StaffUser {
    id: string;
    username: string;
    name: string;
    role: 'admin' | 'delivery';
}

export function readUser(req: Request): StaffUser | null {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET) as StaffUser;
    } catch {
        return null;
    }
}

/** The signed-in user, if their account still exists. A revoked account stops working at once, not when its 7-day login runs out. */
export async function activeUser(req: Request): Promise<StaffUser | null> {
    const user = readUser(req);
    if (!user) return null;
    try {
        return (await staffExists(user.id)) ? user : null;
    } catch {
        return null;
    }
}

async function guard(req: Request, res: Response, next: NextFunction, adminOnly: boolean) {
    const user = await activeUser(req);
    if (!user) {
        res.status(401).json({ error: 'Please sign in again.' });
        return;
    }
    if (adminOnly && user.role !== 'admin') {
        res.status(403).json({ error: 'Only boutique admins can do this.' });
        return;
    }
    res.locals.user = user;
    next();
}

/** Any signed-in team member: boutique admins and delivery staff. */
export const requireStaff = (req: Request, res: Response, next: NextFunction) => guard(req, res, next, false);

/** Boutique admins only. */
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => guard(req, res, next, true);

// ---------------------------------------------------------------- slowing down password guessing

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedLogins = new Map<string, { count: number; since: number }>();

const loginKey = (req: Request, username: string) => `${req.ip}|${username.toLowerCase()}`;

/** Minutes left before this person may try again, or 0. */
export function loginLockedFor(req: Request, username: string): number {
    const entry = failedLogins.get(loginKey(req, username));
    if (!entry) return 0;
    const left = entry.since + LOCKOUT_MS - Date.now();
    if (left <= 0) {
        failedLogins.delete(loginKey(req, username));
        return 0;
    }
    return entry.count >= MAX_FAILED_LOGINS ? Math.ceil(left / 60000) : 0;
}

export function recordLogin(req: Request, username: string, success: boolean) {
    const key = loginKey(req, username);
    if (success) {
        failedLogins.delete(key);
        return;
    }
    const entry = failedLogins.get(key);
    if (entry && Date.now() - entry.since < LOCKOUT_MS) entry.count++;
    else failedLogins.set(key, { count: 1, since: Date.now() });

    // Keep the list from growing without limit
    if (failedLogins.size > 5000) failedLogins.clear();
}
