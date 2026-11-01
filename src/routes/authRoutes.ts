import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { Admin } from '../models/Admin';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'tailor_dashboard_secret_key_2024';

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
            const token = authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).json({ error: 'Unauthorized: Missing admin token.' });
            }
            try {
                const decoded = jwt.verify(token, JWT_SECRET) as any;
                if (decoded.role !== 'admin') {
                    return res.status(403).json({ error: 'Forbidden: Only administrators can create staff accounts.' });
                }
            } catch (err) {
                return res.status(401).json({ error: 'Unauthorized: Invalid or expired admin token.' });
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

        const admin = await Admin.findOne({ username });
        if (!admin) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const isMatch = await (admin as any).comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const token = jwt.sign({ id: admin._id, username: admin.username, name: admin.name, role: (admin as any).role }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ token, name: admin.name, username: admin.username, role: (admin as any).role });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed.' });
    }
});

// Verify token
router.get('/verify', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ valid: false });
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ valid: false });
        }

        const decoded = jwt.verify(token, JWT_SECRET) as any;
        res.json({ valid: true, name: decoded.name, username: decoded.username, role: decoded.role });
    } catch (error) {
        res.status(401).json({ valid: false });
    }
});

// Get delivery staff list
router.get('/staff', async (req, res) => {
    try {
        const staff = await Admin.find({ role: 'delivery' }).select('-password -__v');
        res.json(staff);
    } catch (error) {
        console.error('Fetch staff error:', error);
        res.status(500).json({ error: 'Failed to fetch staff.' });
    }
});

// Delete a staff member
router.delete('/staff/:id', async (req, res) => {
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
