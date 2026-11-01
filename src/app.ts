import express from 'express';
import path from 'path';
import webhookRoutes from './routes/webhookRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import authRoutes from './routes/authRoutes';

const app = express();

app.use(express.json());

// Resolve the public directory path
const publicDir = path.resolve(__dirname, 'public');
console.log('Serving static files from:', publicDir);

// Serve static files (dashboard)
app.use(express.static(publicDir));

// Routes
app.use('/webhook', webhookRoutes);
app.use('/auth', authRoutes);
app.use('/api', dashboardRoutes);

// Dashboard root
app.get('/dashboard', (req, res) => {
    const filePath = path.resolve(publicDir, 'dashboard.html');
    console.log('Sending dashboard file:', filePath);
    res.sendFile(filePath);
});

// Delivery root
app.get('/delivery', (req, res) => {
    const filePath = path.resolve(publicDir, 'delivery.html');
    console.log('Sending delivery file:', filePath);
    res.sendFile(filePath);
});

// Login page
app.get('/login', (req, res) => {
    const filePath = path.resolve(publicDir, 'login.html');
    res.sendFile(filePath);
});

export default app;
