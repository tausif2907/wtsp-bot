import { db } from './pool';

// Stitching bookings and their progress

export interface Order {
    order_id: string;
    customer_phone: string;
    customer_name: string;
    service: string;
    booking_date: string;
    booking_time: string;
    appointment_day: string | null;
    appointment_type: 'visit' | 'pickup';
    latitude: number | null;
    longitude: number | null;
    address: string | null;
    price: number;
    invoice_number: string;
    status: string;
    notes: string;
    created_at: Date;
}

export interface NewOrder {
    order_id: string;
    customer_phone: string;
    customer_name: string;
    service: string;
    booking_date: string;
    booking_time: string;
    appointment_day?: string;
    appointment_type: 'visit' | 'pickup';
    latitude?: number;
    longitude?: number;
    address?: string;
    price: number;
    invoice_number: string;
    status: string;
}

export async function createOrder(order: NewOrder): Promise<Order> {
    const { rows } = await db().query(
        `insert into bot.orders (order_id, customer_phone, customer_name, service, booking_date, booking_time, appointment_day,
                                 appointment_type, latitude, longitude, address, price, invoice_number, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         returning *`,
        [
            order.order_id, order.customer_phone, order.customer_name, order.service, order.booking_date, order.booking_time,
            order.appointment_day || null, order.appointment_type, order.latitude ?? null, order.longitude ?? null,
            order.address ?? null, order.price, order.invoice_number, order.status
        ]
    );
    return rows[0];
}

/** Newest first */
export async function listOrders(): Promise<Order[]> {
    const { rows } = await db().query('select * from bot.orders order by created_at desc');
    return rows;
}

export async function listOrdersFor(phone: string, limit: number): Promise<Order[]> {
    const { rows } = await db().query('select * from bot.orders where customer_phone = $1 order by created_at desc limit $2', [phone, limit]);
    return rows;
}

export async function findOrder(orderId: string): Promise<Order | null> {
    const { rows } = await db().query('select * from bot.orders where order_id = $1', [orderId]);
    return rows[0] || null;
}

export async function setOrderStatus(orderId: string, status: string): Promise<Order | null> {
    const { rows } = await db().query('update bot.orders set status = $2 where order_id = $1 returning *', [orderId, status]);
    return rows[0] || null;
}

/** Sets the price after measurement and/or the team's notes; leaves out whatever isn't given. */
export async function updateOrder(orderId: string, changes: { price?: number; notes?: string }): Promise<Order | null> {
    const { rows } = await db().query(
        'update bot.orders set price = coalesce($2::integer, price), notes = coalesce($3::text, notes) where order_id = $1 returning *',
        [orderId, changes.price ?? null, changes.notes ?? null]
    );
    return rows[0] || null;
}
