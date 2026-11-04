import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { newDb, DataType } from 'pg-mem';

// The bot's real tables, from supabase/bot-database.sql, in an in-memory Postgres,
// so the tests run the same SQL the bot sends to Supabase.
// Use in a test file:  jest.mock('../src/db/pool', () => require('./helpers/memoryDb').mockPoolModule());

export function createMemoryDb() {
    const mem = newDb();
    // Built into Postgres, missing from pg-mem
    mem.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, implementation: () => crypto.randomUUID(), impure: true });
    mem.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (s: string) => s.length });
    mem.public.registerFunction({
        name: 'jsonb_typeof', args: [DataType.jsonb], returns: DataType.text,
        implementation: (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'object' ? 'object' : typeof v)
    });

    // Roles, grants and row level security are Supabase setup, not something pg-mem can run
    const sql = fs.readFileSync(path.join(__dirname, '../../supabase/bot-database.sql'), 'utf8');
    const tables = sql.split('-- ================================================================ access')[0] as string;
    mem.public.none(tables.replace(/--.*$/gm, ''));

    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();
    const empty = mem.backup();
    return {
        pool,
        /** Raw SQL, for setting up situations the bot can't create itself */
        sql: (text: string) => mem.public.none(text),
        /** Back to empty tables */
        reset: () => empty.restore()
    };
}

export function mockPoolModule() {
    const memory = createMemoryDb();
    return { db: () => memory.pool, connectDB: async () => { }, memory };
}

export type MemoryDb = ReturnType<typeof createMemoryDb>;

/** The in-memory database behind the mocked src/db/pool */
export const memoryDb = (): MemoryDb => (jest.requireMock('../../src/db/pool') as any).memory;
