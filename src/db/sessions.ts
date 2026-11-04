import { db } from './pool';

// Where each customer is in the WhatsApp conversation. A session left alone for a day is
// forgotten, so the next message starts afresh.

export interface CartItem {
    service: string;
    price: number;
}

const FIELDS = [
    'current_step', 'name', 'selected_service', 'selected_date', 'selected_day', 'selected_time',
    'location_lat', 'location_lng', 'address', 'appointment_type', 'browse_category', 'browse_page',
    'product_id', 'handoff_at', 'handoff_topic', 'cart'
] as const;

export class ConversationSession {
    phone_number: string;
    current_step = 'start';
    name: string | null = null;
    selected_service: string | null = null;
    selected_date: string | null = null;
    selected_day: string | null = null;
    selected_time: string | null = null;
    location_lat: number | null = null;
    location_lng: number | null = null;
    address: string | null = null;
    appointment_type: string | null = null;
    browse_category: string | null = null;
    browse_page: number | null = null;
    product_id: string | null = null;
    handoff_at: Date | null = null;
    handoff_topic: string | null = null;
    cart: CartItem[] = [];
    updated_at: Date | null = null;

    constructor(phone: string, row: Record<string, any> = {}) {
        this.phone_number = phone;
        for (const field of FIELDS) if (row[field] !== undefined && row[field] !== null) (this as any)[field] = row[field];
        if (row.updated_at) this.updated_at = row.updated_at;
    }

    async save(): Promise<this> {
        const values = FIELDS.map(field => (field === 'cart' ? JSON.stringify(this.cart || []) : (this as any)[field] ?? null));
        const { rows } = await db().query(
            `insert into bot.sessions (phone_number, ${FIELDS.join(', ')}, updated_at)
             values ($1, ${FIELDS.map((_, i) => `$${i + 2}`).join(', ')}, now())
             on conflict (phone_number) do update set ${FIELDS.map(f => `${f} = excluded.${f}`).join(', ')}, updated_at = now()
             returning updated_at`,
            [this.phone_number, ...values]
        );
        this.updated_at = rows[0].updated_at;
        return this;
    }
}

const FRESH = `updated_at > now() - interval '24 hours'`;

export const newSession = (phone: string) => new ConversationSession(phone);

/** The customer's conversation, or null if they have none from the last 24 hours. */
export async function loadSession(phone: string): Promise<ConversationSession | null> {
    const { rows } = await db().query(`select * from bot.sessions where phone_number = $1 and ${FRESH}`, [phone]);
    return rows[0] ? new ConversationSession(phone, rows[0]) : null;
}

export async function deleteSession(phone: string): Promise<void> {
    await db().query('delete from bot.sessions where phone_number = $1', [phone]);
}

/** Customers currently talking to the team (the dashboard inbox), most recent first. */
export async function listOpenChats(): Promise<ConversationSession[]> {
    const { rows } = await db().query(`select * from bot.sessions where current_step = 'talking_to_staff' and ${FRESH} order by updated_at desc`);
    return rows.map(row => new ConversationSession(row.phone_number, row));
}

/** Keeps a chat open while the team is replying. */
export async function touchSession(phone: string): Promise<void> {
    await db().query('update bot.sessions set updated_at = now() where phone_number = $1', [phone]);
}

/** Hands a customer back to the bot after the team is done chatting. */
export async function closeChat(phone: string): Promise<void> {
    await db().query(`update bot.sessions set current_step = 'start', updated_at = now() where phone_number = $1 and current_step = 'talking_to_staff'`, [phone]);
}

export async function purgeExpiredSessions(): Promise<number> {
    const { rowCount } = await db().query(`delete from bot.sessions where updated_at <= now() - interval '24 hours'`);
    return rowCount || 0;
}
