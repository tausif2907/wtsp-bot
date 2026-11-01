import mongoose from 'mongoose';

export const connectDB = async (retries = 3) => {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tailorbot';
    for (let i = 0; i < retries; i++) {
        try {
            await mongoose.connect(uri);
            console.log('MongoDB connected successfully');
            return;
        } catch (error) {
            console.error(`MongoDB connection attempt ${i + 1}/${retries} failed:`, error);
            if (i < retries - 1) {
                console.log('Retrying in 3 seconds...');
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
    console.error('All MongoDB connection attempts failed. Exiting.');
    process.exit(1);
};
