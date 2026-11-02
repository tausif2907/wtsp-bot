import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

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

/** Any signed-in team member: boutique admins and delivery staff. */
export function requireStaff(req: Request, res: Response, next: NextFunction) {
    const user = readUser(req);
    if (!user) {
        res.status(401).json({ error: 'Please sign in again.' });
        return;
    }
    res.locals.user = user;
    next();
}

/** Boutique admins only. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const user = readUser(req);
    if (!user) {
        res.status(401).json({ error: 'Please sign in again.' });
        return;
    }
    if (user.role !== 'admin') {
        res.status(403).json({ error: 'Only boutique admins can do this.' });
        return;
    }
    res.locals.user = user;
    next();
}
