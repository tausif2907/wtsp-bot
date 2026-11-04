import { db } from './pool';

// Everyone who messaged the bot or was imported from a CSV, for broadcasts

export interface Lead {
    id: string;
    phone_number: string;
    name: string;
    type: 'registered' | 'unregistered';
    source: 'whatsapp' | 'csv_import';
    last_active: Date;
    created_at: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every message counts as activity; a number first imported from a CSV now counts as a WhatsApp contact. */
export async function touchLead(phone: string): Promise<void> {
    await db().query(
        `insert into bot.leads (phone_number, last_active, source) values ($1, now(), 'whatsapp')
         on conflict (phone_number) do update set last_active = now(), source = 'whatsapp'`,
        [phone]
    );
}

export async function findLeadName(phone: string): Promise<string> {
    const { rows } = await db().query('select name from bot.leads where phone_number = $1', [phone]);
    return rows[0]?.name || '';
}

export async function saveLeadName(phone: string, name: string): Promise<void> {
    await db().query(
        `insert into bot.leads (phone_number, name) values ($1, $2)
         on conflict (phone_number) do update set name = excluded.name`,
        [phone, name]
    );
}

/** After a confirmed booking the contact becomes a registered customer. */
export async function markLeadRegistered(phone: string, name: string): Promise<void> {
    await db().query(
        `insert into bot.leads (phone_number, name, type) values ($1, $2, 'registered')
         on conflict (phone_number) do update set name = excluded.name, type = 'registered'`,
        [phone, name]
    );
}

/** Registered customers first, then the rest; most recently active first. */
export async function listLeads(type?: 'registered' | 'unregistered'): Promise<Lead[]> {
    const { rows } = type
        ? await db().query('select * from bot.leads where type = $1 order by last_active desc', [type])
        : await db().query('select * from bot.leads order by type asc, last_active desc');
    return rows;
}

/**
 * Adds a contact from a CSV import. A number already known (with or without the 91 prefix) is kept,
 * switched to the 91 form and given the name if it had none.
 */
export async function importLead(phone: string, variants: string[], name: string): Promise<'imported' | 'skipped'> {
    const numbers = variants.length ? variants : [phone];
    const { rows } = await db().query(
        `select id, phone_number from bot.leads where phone_number in (${numbers.map((_, i) => `$${i + 1}`).join(', ')}) limit 1`,
        numbers
    );
    const existing = rows[0];
    if (!existing) {
        await db().query(
            `insert into bot.leads (phone_number, name, type, source) values ($1, $2, 'unregistered', 'csv_import')
             on conflict (phone_number) do nothing`,
            [phone, name]
        );
        return 'imported';
    }

    try {
        await db().query(
            `update bot.leads set phone_number = $2, name = case when name = '' then $3 else name end where id = $1`,
            [existing.id, phone, name]
        );
    } catch (error: any) {
        if (error?.code !== '23505') throw error; // both forms of the number are already saved
    }
    return 'skipped';
}

export async function deleteLeads(filter: { source: 'csv_import' } | { type: 'unregistered' }): Promise<number> {
    const { rowCount } = 'source' in filter
        ? await db().query('delete from bot.leads where source = $1', [filter.source])
        : await db().query('delete from bot.leads where type = $1', [filter.type]);
    return rowCount || 0;
}

export async function deleteLead(id: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) return;
    await db().query('delete from bot.leads where id = $1', [id]);
}
