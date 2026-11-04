import 'dotenv/config';
import app from './app';
import { connectDB } from './config/db';
import { startCatalogSync } from './services/catalog';

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDB();
    // Products added or changed on the website reach the bot within 30 seconds
    startCatalogSync();

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
};

startServer();
