import 'dotenv/config';
import app from './app';
import { connectDB } from './db/pool';
import { purgeExpiredSessions } from './db/sessions';
import { announceSetupIfNeeded } from './routes/authRoutes';
import { startCatalogSync } from './services/catalog';

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDB();
    await announceSetupIfNeeded();
    // Products added or changed on the website reach the bot within 30 seconds
    startCatalogSync();
    // Conversations untouched for a day are forgotten
    setInterval(() => purgeExpiredSessions().catch(error => console.error('Could not clear old conversations:', error.message)), 60 * 60 * 1000).unref();

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
};

startServer();
