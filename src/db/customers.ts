import { db } from './pool';

// Customers who booked through WhatsApp

export interface Customer {
    phone_number: string;
    name: string;
    location_lat: number | null;
    location_lng: number | null;
    address: string | null;
    created_at: Date;
}

export async function listCustomers(): Promise<Customer[]> {
    const { rows } = await db().query('select * from bot.customers order by created_at desc');
    return rows;
}

/** Saves the customer's name, and their pickup location and address when given (a visit keeps the old ones). */
export async function upsertCustomer(phone: string, details: { name: string; location_lat?: number; location_lng?: number; address?: string }): Promise<void> {
    await db().query(
        `insert into bot.customers (phone_number, name, location_lat, location_lng, address)
         values ($1, $2, $3, $4, $5)
         on conflict (phone_number) do update set
           name = excluded.name,
           location_lat = coalesce(excluded.location_lat, bot.customers.location_lat),
           location_lng = coalesce(excluded.location_lng, bot.customers.location_lng),
           address = coalesce(excluded.address, bot.customers.address)`,
        [phone, details.name || '', details.location_lat ?? null, details.location_lng ?? null, details.address ?? null]
    );
}
