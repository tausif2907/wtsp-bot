import express from 'express';
import webhookRoutes from './routes/webhookRoutes';

const app = express();

app.use(express.json());

// Routes
app.use('/webhook', webhookRoutes);

export default app;
