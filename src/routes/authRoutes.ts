import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { Admin } from '../models/Admin';
import { JWT_SECRET, requireAdmin, requireStaff, activeUser, loginLockedFor, recordLogin } from '../middleware/auth';

const router = Router();

// Signup (Also used to create staff by Admins)
router.post('/signup', async (req, res) => {
    try {
        // SECURITY GATE: Prevent unauthorized account creation
        const adminCount = await Admin.countDocuments({ role: 'admin' });
        const isFirstAdmin = adminCount === 0;

        if (!isFirstAdmin) {
            // Require a valid Admin JWT token to create any new accounts
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Unauthorized: Admin login required to create accounts.' });
            }
            const creator = await activeUser(req);
            if (!creator) {
                return res.status(401).json({ error: 'Unauthorized: Invalid or expired admin token.' });
            }
            if (creator.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden: Only administrators can create staff accounts.' });
            }

            // Lock down role creation
            if (req.body.role === 'admin') {
                return res.status(403).json({ error: 'Forbidden: Cannot create additional administrator accounts.' });
            }
        }

        const { name, username, password, role } = req.body;

        if (!name || !username || !password) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }

        const existing = await Admin.findOne({ username });
        if (existing) {
            return res.status(400).json({ error: 'An account with this username already exists.' });
        }

        const admin = new Admin({ name, username, password, role: role || 'admin' });
        await admin.save();

        const token = jwt.sign({ id: admin._id, username: admin.username, name: admin.name, role: admin.role }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({ token, name: admin.name, username: admin.username, role: admin.role });
    } catch (error: any) {
        console.error('Signup error:', error);
        require('fs').appendFileSync('signup-error.log', JSON.stringify({ message: error.message, stack: error.stack }) + '\n');
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

        const admin = await Admin.findOne({ username: String(username) });
        const isMatch = admin ? await (admin as any).comparePassword(String(password)) : false;
        recordLogin(req, String(username), isMatch);
        if (!admin || !isMatch) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const token = jwt.sign({ id: admin._id, username: admin.username, name: admin.name, role: (admin as any).role }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ token, name: admin.name, username: admin.username, role: (admin as any).role });
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
        if (typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ error: 'The new password needs at least 8 characters.' });
        }

        const admin = await Admin.findById(res.locals.user.id);
        if (!admin || !(await (admin as any).comparePassword(String(currentPassword || '')))) {
            return res.status(400).json({ error: 'Your current password is not right.' });
        }

        admin.password = newPassword; // hashed by the model before saving
        await admin.save();
        res.json({ success: true });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Failed to change the password.' });
    }
});

// Get delivery staff list
router.get('/staff', requireAdmin, async (req, res) => {
    try {
        const staff = await Admin.find({ role: 'delivery' }).select('-password -__v');
        res.json(staff);
    } catch (error) {
        console.error('Fetch staff error:', error);
        res.status(500).json({ error: 'Failed to fetch staff.' });
    }
});

// Delete a staff member
router.delete('/staff/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await Admin.findOneAndDelete({ _id: id, role: 'delivery' });

        if (!result) {
            return res.status(404).json({ error: 'Staff account not found or cannot be deleted.' });
        }
        res.json({ success: true, message: 'Staff deleted successfully.' });
    } catch (error) {
        console.error('Delete staff error:', error);
        res.status(500).json({ error: 'Failed to delete staff.' });
    }
});

export default router;
