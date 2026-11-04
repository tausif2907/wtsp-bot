import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
    countAdmins, createStaff, findStaffForLogin, findStaffWithHash, listDeliveryStaff, removeDeliveryStaff,
    setStaffPassword, checkPassword, UsernameTakenError, StaffMember
} from '../db/staff';
import { JWT_SECRET, requireAdmin, requireStaff, activeUser, loginLockedFor, recordLogin } from '../middleware/auth';

const router = Router();

const MIN_PASSWORD = 8;

const signIn = (account: StaffMember) => ({
    token: jwt.sign({ id: account.id, username: account.username, name: account.name, role: account.role }, JWT_SECRET, { expiresIn: '7d' }),
    name: account.name,
    username: account.username,
    role: account.role
});

// ---------------------------------------------------------------- first-time setup
// While there is no admin yet, the first one is created on the login page with a one-time code
// that only appears in the server's console, so nobody who merely finds the link can claim the account.

let setupCode: string | null = null;
let wrongSetupCodes = 0;

function newSetupCode(): string {
    const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 8 }, () => letters[crypto.randomInt(letters.length)]).join('');
    setupCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    wrongSetupCodes = 0;
    console.log(`\nNo admin account yet. Open the dashboard login page and create one with setup code: ${setupCode}\n`);
    return setupCode;
}

/** Prints a setup code when the database has no admin yet. */
export async function announceSetupIfNeeded() {
    if ((await countAdmins()) === 0 && !setupCode) newSetupCode();
}

function setupCodeMatches(candidate: unknown): boolean {
    if (!setupCode) newSetupCode();
    const given = Buffer.from(String(candidate || '').trim().toUpperCase());
    const expected = Buffer.from(setupCode as string);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    // Guessing is pointless: after 10 wrong codes a new one is printed
    if (!ok && ++wrongSetupCodes >= 10) newSetupCode();
    return ok;
}

// The login page asks whether to show the setup form
router.get('/setup', async (req, res) => {
    try {
        res.json({ needed: (await countAdmins()) === 0 });
    } catch (error) {
        res.status(500).json({ error: 'Could not reach the database.' });
    }
});

// Signup: the first admin (with the setup code), or delivery staff created by an admin
router.post('/signup', async (req, res) => {
    try {
        const isFirstAdmin = (await countAdmins()) === 0;
        let role: 'admin' | 'delivery' = 'delivery';

        if (isFirstAdmin) {
            if (!setupCodeMatches(req.body.setupCode)) {
                return res.status(403).json({ error: 'That setup code is not right. Use the code shown in the bot\'s console window.' });
            }
            role = 'admin';
        } else {
            const creator = await activeUser(req);
            if (!creator) {
                return res.status(401).json({ error: 'Unauthorized: Admin login required to create accounts.' });
            }
            if (creator.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden: Only administrators can create staff accounts.' });
            }
            if (req.body.role === 'admin') {
                return res.status(403).json({ error: 'Forbidden: Cannot create additional administrator accounts.' });
            }
        }

        const { name, username, password } = req.body;
        if (!name || !username || !password) {
            return res.status(400).json({ error: 'All fields are required.' });
        }
        if (String(password).length < MIN_PASSWORD) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
        }

        const account = await createStaff({ name: String(name), username: String(username), password: String(password), role });
        if (isFirstAdmin) {
            setupCode = null;
            console.log(`Admin account "${account.username}" created.`);
        }

        res.status(201).json(signIn(account));
    } catch (error: any) {
        if (error instanceof UsernameTakenError) return res.status(400).json({ error: error.message });
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Failed to create account.' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        // The dashboard is reachable from the internet, so slow down password guessing
        const lockedMinutes = loginLockedFor(req, String(username));
        if (lockedMinutes) {
            return res.status(429).json({ error: `Too many wrong passwords. Please try again in ${lockedMinutes} minute${lockedMinutes === 1 ? '' : 's'}.` });
        }

        const account = await findStaffForLogin(String(username));
        const isMatch = account ? await checkPassword(account, String(password)) : false;
        recordLogin(req, String(username), isMatch);
        if (!account || !isMatch) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        res.json(signIn(account));
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed.' });
    }
});

// Verify token (and that the account hasn't been revoked)
router.get('/verify', async (req, res) => {
    const user = await activeUser(req);
    if (!user) return res.status(401).json({ valid: false });
    res.json({ valid: true, name: user.name, username: user.username, role: user.role });
});

// Change your own password
router.post('/password', requireStaff, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
            return res.status(400).json({ error: `The new password needs at least ${MIN_PASSWORD} characters.` });
        }

        const account = await findStaffWithHash(res.locals.user.id);
        if (!account || !(await checkPassword(account, String(currentPassword || '')))) {
            return res.status(400).json({ error: 'Your current password is not right.' });
        }

        await setStaffPassword(account.id, newPassword);
        res.json({ success: true });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Failed to change the password.' });
    }
});

// Get delivery staff list
router.get('/staff', requireAdmin, async (req, res) => {
    try {
        res.json(await listDeliveryStaff());
    } catch (error) {
        console.error('Fetch staff error:', error);
        res.status(500).json({ error: 'Failed to fetch staff.' });
    }
});

// Delete a staff member
router.delete('/staff/:id', requireAdmin, async (req, res) => {
    try {
        const removed = await removeDeliveryStaff(String(req.params.id));
        if (!removed) {
            return res.status(404).json({ error: 'Staff account not found or cannot be deleted.' });
        }
        res.json({ success: true, message: 'Staff deleted successfully.' });
    } catch (error) {
        console.error('Delete staff error:', error);
        res.status(500).json({ error: 'Failed to delete staff.' });
    }
});

export default router;
