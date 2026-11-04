import { db } from './pool';

// Messages exchanged while a customer talks to the team, shown in the dashboard inbox
// (the bot's WhatsApp number can't be used in the WhatsApp app).

export interface ChatMessage {
    id: string;
    phone_number: string;
    direction: 'in' | 'out';
    text: string;
    media_id: string | null;
    media_type: string | null;
    sent_by: string | null;
    created_at: Date;
}

export async function addChatMessage(message: {
    phone_number: string;
    direction: 'in' | 'out';
    text: string;
    media_id?: string;
    media_type?: string;
    sent_by?: string;
}): Promise<ChatMessage> {
    const { rows } = await db().query(
        `insert into bot.chat_messages (phone_number, direction, text, media_id, media_type, sent_by)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [message.phone_number, message.direction, message.text || '', message.media_id ?? null, message.media_type ?? null, message.sent_by ?? null]
    );
    return rows[0];
}

export async function lastMessageSince(phone: string, since: Date): Promise<ChatMessage | null> {
    const { rows } = await db().query(
        'select * from bot.chat_messages where phone_number = $1 and created_at >= $2 order by created_at desc, seq desc limit 1',
        [phone, since]
    );
    return rows[0] || null;
}

export async function lastCustomerMessage(phone: string): Promise<ChatMessage | null> {
    const { rows } = await db().query(
        `select * from bot.chat_messages where phone_number = $1 and direction = 'in' order by created_at desc, seq desc limit 1`,
        [phone]
    );
    return rows[0] || null;
}

/** The latest messages, oldest first. */
export async function recentMessages(phone: string, limit = 100): Promise<ChatMessage[]> {
    const { rows } = await db().query(
        'select * from bot.chat_messages where phone_number = $1 order by created_at desc, seq desc limit $2',
        [phone, limit]
    );
    return rows.reverse();
}
