import bcrypt from 'bcryptjs';
import { db } from './pool';

// Dashboard logins: the boutique admin and delivery staff

export interface StaffMember {
    id: string;
    name: string;
    username: string;
    role: 'admin' | 'delivery';
    created_at: Date;
}

interface StaffWithHash extends StaffMember {
    password_hash: string;
}

const PUBLIC_COLUMNS = 'id, name, username, role, created_at';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const normaliseUsername = (username: string) => String(username || '').trim().toLowerCase();

export class UsernameTakenError extends Error { }

export async function countAdmins(): Promise<number> {
    const { rows } = await db().query(`select count(*)::int as count from bot.staff where role = 'admin'`);
    return rows[0].count;
}

export async function findStaffForLogin(username: string): Promise<StaffWithHash | null> {
    const { rows } = await db().query(`select ${PUBLIC_COLUMNS}, password_hash from bot.staff where username = $1`, [normaliseUsername(username)]);
    return rows[0] || null;
}

export async function findStaffWithHash(id: string): Promise<StaffWithHash | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const { rows } = await db().query(`select ${PUBLIC_COLUMNS}, password_hash from bot.staff where id = $1`, [id]);
    return rows[0] || null;
}

/** False once an account has been revoked, so its login stops working straight away. */
export async function staffExists(id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(String(id))) return false;
    const { rowCount } = await db().query('select 1 from bot.staff where id = $1', [id]);
    return Boolean(rowCount);
}

export async function createStaff(input: { name: string; username: string; password: string; role: 'admin' | 'delivery' }): Promise<StaffMember> {
    const hash = await bcrypt.hash(input.password, 10);
    try {
        const { rows } = await db().query(
            `insert into bot.staff (name, username, password_hash, role) values ($1, $2, $3, $4) returning ${PUBLIC_COLUMNS}`,
            [String(input.name).trim(), normaliseUsername(input.username), hash, input.role]
        );
        return rows[0];
    } catch (error: any) {
        if (error?.code === '23505') throw new UsernameTakenError('An account with this username already exists.');
        throw error;
    }
}

export async function listDeliveryStaff(): Promise<StaffMember[]> {
    const { rows } = await db().query(`select ${PUBLIC_COLUMNS} from bot.staff where role = 'delivery' order by created_at`);
    return rows;
}

/** Removes a delivery account (admin accounts can't be removed this way). */
export async function removeDeliveryStaff(id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) return false;
    const { rowCount } = await db().query(`delete from bot.staff where id = $1 and role = 'delivery'`, [id]);
    return Boolean(rowCount);
}

export async function setStaffPassword(id: string, password: string): Promise<void> {
    const hash = await bcrypt.hash(password, 10);
    await db().query('update bot.staff set password_hash = $2 where id = $1', [id, hash]);
}

export const checkPassword = (account: { password_hash: string }, candidate: string) => bcrypt.compare(String(candidate), account.password_hash);
