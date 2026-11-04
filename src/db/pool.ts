import fs from 'fs';
import { Pool, types } from 'pg';

// The bot keeps its data in the online store's Supabase project, in its own "bot" schema
// (see supabase/bot-database.sql). It signs in as the rashmi_bot role, which can use only those tables.

// Appointment days stay as "YYYY-MM-DD" text instead of becoming midnight in some time zone
types.setTypeParser(1082, value => value);

let pool: Pool | null = null;

/** The connection pool, created on first use. */
export function db(): Pool {
    if (!pool) {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is not set in .env');

        // Supabase signs its certificates with its own CA. Point DATABASE_CA_CERT at that file
        // (Database Settings -> SSL Configuration) to have the certificate checked as well.
        const caPath = process.env.DATABASE_CA_CERT;
        const ssl = caPath ? { ca: fs.readFileSync(caPath, 'utf8') } : { rejectUnauthorized: false };

        pool = new Pool({
            // An "sslmode" in the address would replace the ssl settings above, so drop it
            connectionString: url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''),
            ssl,
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000
        });
        pool.on('error', error => console.error('Database connection error:', error.message));
    }
    return pool;
}

// Turns the usual setup mistakes into something the owner can act on
function explain(error: any): string {
    const message = String(error?.message || error);
    if (error?.code === '42P01' || error?.code === '3F000') return 'The bot\'s tables are not in Supabase yet. Run supabase/bot-database.sql in the Supabase SQL Editor.';
    if (error?.code === '28P01') return 'Supabase refused the password in DATABASE_URL. It must match the one in supabase/bot-database.sql.';
    if (error?.code === '42501') return 'The rashmi_bot login can\'t use the bot tables. Run supabase/bot-database.sql again.';
    if (/tenant or user not found/i.test(message)) return 'Supabase doesn\'t know this login. In DATABASE_URL the user must be rashmi_bot.<project-ref> and the host your project\'s pooler address.';
    if (error?.code === 'ENOTFOUND') return `Can't find the database host in DATABASE_URL (${error.hostname}).`;
    return message;
}

export const connectDB = async (retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            await db().query('select count(*) from bot.staff');
            console.log('Connected to the bot database in Supabase');
            return;
        } catch (error) {
            console.error(`Database connection attempt ${i + 1}/${retries} failed: ${explain(error)}`);
            if (i < retries - 1) {
                console.log('Retrying in 3 seconds...');
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
    console.error('All database connection attempts failed. Exiting.');
    process.exit(1);
};
