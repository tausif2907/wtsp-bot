import { memoryDb } from './helpers/memoryDb';
import {
    countAdmins, createStaff, findStaffForLogin, findStaffWithHash, staffExists, listDeliveryStaff,
    removeDeliveryStaff, setStaffPassword, checkPassword, UsernameTakenError
} from '../src/db/staff';
import { listCustomers, upsertCustomer } from '../src/db/customers';
import { touchLead, findLeadName, saveLeadName, markLeadRegistered, listLeads, importLead, deleteLeads, deleteLead } from '../src/db/leads';
import { createOrder, listOrders, listOrdersFor, findOrder, setOrderStatus, updateOrder, NewOrder } from '../src/db/orders';
import { newSession, loadSession, deleteSession, listOpenChats, touchSession, closeChat, purgeExpiredSessions } from '../src/db/sessions';
import { addChatMessage, lastMessageSince, lastCustomerMessage, recentMessages } from '../src/db/chats';

jest.mock('../src/db/pool', () => require('./helpers/memoryDb').mockPoolModule());

const PHONE = '919876543210';
const day = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

const booking = (fields: Partial<NewOrder> = {}): NewOrder => ({
    order_id: 'ab12cd34-1111-2222-3333-444455556666',
    customer_phone: PHONE,
    customer_name: 'Priya',
    service: 'Designer Blouse',
    booking_date: 'Thu, 5 Nov',
    booking_time: '01:00 PM - 03:00 PM',
    appointment_day: '2026-11-05',
    appointment_type: 'visit',
    price: 0,
    invoice_number: 'RB-20261104-1234',
    status: 'order_received',
    ...fields
});

beforeEach(() => memoryDb().reset());

describe('Dashboard logins (bot.staff)', () => {
    it('creates the admin, signs in by username in any case, and never returns the password hash', async () => {
        expect(await countAdmins()).toBe(0);
        const admin = await createStaff({ name: 'Rashmi', username: '  Rashmi ', password: 'boutique-2026', role: 'admin' });

        expect(admin).toMatchObject({ name: 'Rashmi', username: 'rashmi', role: 'admin' });
        expect(admin).not.toHaveProperty('password_hash');
        expect(await countAdmins()).toBe(1);

        const login = await findStaffForLogin('RASHMI');
        expect(await checkPassword(login!, 'boutique-2026')).toBe(true);
        expect(await checkPassword(login!, 'wrong')).toBe(false);
        expect(login!.password_hash).not.toContain('boutique-2026');
    });

    it('refuses a username that is already taken', async () => {
        await createStaff({ name: 'Ravi', username: 'ravi', password: 'deliver-123', role: 'delivery' });
        await expect(createStaff({ name: 'Ravi K', username: 'Ravi', password: 'deliver-456', role: 'delivery' })).rejects.toBeInstanceOf(UsernameTakenError);
    });

    it('revokes delivery staff but never the admin', async () => {
        const admin = await createStaff({ name: 'Rashmi', username: 'rashmi', password: 'boutique-2026', role: 'admin' });
        const ravi = await createStaff({ name: 'Ravi', username: 'ravi', password: 'deliver-123', role: 'delivery' });

        expect((await listDeliveryStaff()).map(s => s.username)).toEqual(['ravi']);
        expect(await removeDeliveryStaff(admin.id)).toBe(false);
        expect(await removeDeliveryStaff(ravi.id)).toBe(true);
        expect(await staffExists(ravi.id)).toBe(false);
        expect(await staffExists(admin.id)).toBe(true);
        expect(await staffExists('not-a-real-id')).toBe(false);
    });

    it('changes a password', async () => {
        const admin = await createStaff({ name: 'Rashmi', username: 'rashmi', password: 'boutique-2026', role: 'admin' });
        await setStaffPassword(admin.id, 'new-secret-2026');
        const account = await findStaffWithHash(admin.id);
        expect(await checkPassword(account!, 'new-secret-2026')).toBe(true);
        expect(await checkPassword(account!, 'boutique-2026')).toBe(false);
    });
});

describe('Customers and leads', () => {
    it('keeps the pickup address when the same customer later books a visit', async () => {
        await upsertCustomer(PHONE, { name: 'Priya', location_lat: 22.8, location_lng: 86.2, address: 'Flat 4, Sakchi' });
        await upsertCustomer(PHONE, { name: 'Priya Sharma' });

        const [customer] = await listCustomers();
        expect(customer).toMatchObject({ name: 'Priya Sharma', location_lat: 22.8, address: 'Flat 4, Sakchi' });
    });

    it('tracks a contact from their first message to a confirmed booking', async () => {
        await touchLead(PHONE);
        expect(await findLeadName(PHONE)).toBe('');

        await saveLeadName(PHONE, 'Priya');
        await touchLead(PHONE);
        expect(await findLeadName(PHONE)).toBe('Priya');

        await touchLead('919000000002');
        await markLeadRegistered(PHONE, 'Priya');
        const leads = await listLeads();
        expect(leads.map(l => `${l.phone_number}:${l.type}`)).toEqual([`${PHONE}:registered`, '919000000002:unregistered']);
        expect((await listLeads('unregistered')).map(l => l.phone_number)).toEqual(['919000000002']);
    });

    it('imports CSV contacts without duplicating numbers saved without the 91 prefix', async () => {
        await saveLeadName('9876543210', '');
        expect(await importLead(PHONE, [PHONE, '9876543210'], 'Priya')).toBe('skipped');
        expect(await importLead('919111111111', ['919111111111', '9111111111'], 'Asha')).toBe('imported');

        const leads = await listLeads();
        expect(leads.find(l => l.phone_number === PHONE)?.name).toBe('Priya');
        expect(leads.find(l => l.phone_number === '919111111111')?.source).toBe('csv_import');

        expect(await deleteLeads({ source: 'csv_import' })).toBe(1);
        const [left] = await listLeads();
        await deleteLead(left!.id);
        await deleteLead('not-a-real-id');
        expect(await listLeads()).toEqual([]);
    });
});

describe('Orders (bot.orders)', () => {
    it('saves a booking with the day, defaults and no price yet', async () => {
        const order = await createOrder(booking());
        expect(order).toMatchObject({ status: 'order_received', price: 0, notes: '', appointment_type: 'visit', address: null });
        expect(day(order.appointment_day)).toBe('2026-11-05');
        expect(order.created_at).toBeInstanceOf(Date);
    });

    it('lists a customer\'s latest bookings first', async () => {
        await createOrder(booking({ order_id: 'first' }));
        memoryDb().sql(`update bot.orders set created_at = created_at - interval '1 day' where order_id = 'first'`);
        await createOrder(booking({ order_id: 'second' }));
        await createOrder(booking({ order_id: 'someone-else', customer_phone: '919000000002' }));

        expect((await listOrdersFor(PHONE, 5)).map(o => o.order_id)).toEqual(['second', 'first']);
        expect(await listOrdersFor(PHONE, 1)).toHaveLength(1);
        expect(await listOrders()).toHaveLength(3);
    });

    it('updates status, price and notes separately', async () => {
        await createOrder(booking());
        const id = booking().order_id;

        expect((await setOrderStatus(id, 'in_stitching'))?.status).toBe('in_stitching');
        expect((await updateOrder(id, { price: 1850 }))?.price).toBe(1850);
        const noted = await updateOrder(id, { notes: 'Bust 34' });
        expect(noted).toMatchObject({ price: 1850, notes: 'Bust 34', status: 'in_stitching' });

        expect(await findOrder('missing')).toBeNull();
        expect(await setOrderStatus('missing', 'ready')).toBeNull();
    });

    it('refuses an unknown status', async () => {
        await createOrder(booking());
        await expect(setOrderStatus(booking().order_id, 'lost')).rejects.toThrow();
    });
});

describe('Conversations (bot.sessions)', () => {
    it('saves and reloads where the customer is, including their cart', async () => {
        const session = newSession(PHONE);
        session.current_step = 'cart_review';
        session.name = 'Priya';
        session.cart = [{ service: 'Designer Blouse', price: 0 }];
        session.browse_page = 2;
        await session.save();

        session.cart.push({ service: 'Lehenga Choli', price: 0 });
        await session.save();

        const loaded = await loadSession(PHONE);
        expect(loaded).toMatchObject({ phone_number: PHONE, current_step: 'cart_review', name: 'Priya', browse_page: 2 });
        expect(loaded!.cart.map(i => i.service)).toEqual(['Designer Blouse', 'Lehenga Choli']);
        expect(loaded!.updated_at).toBeInstanceOf(Date);

        await deleteSession(PHONE);
        expect(await loadSession(PHONE)).toBeNull();
    });

    it('forgets a conversation left alone for a day', async () => {
        await newSession(PHONE).save();
        await newSession('919000000002').save();
        memoryDb().sql(`update bot.sessions set updated_at = now() - interval '25 hours' where phone_number = '${PHONE}'`);

        expect(await loadSession(PHONE)).toBeNull();
        expect(await loadSession('919000000002')).not.toBeNull();
        expect(await purgeExpiredSessions()).toBe(1);
    });

    it('lists open chats with the team, keeps them open on reply and hands them back to the bot', async () => {
        const chat = newSession(PHONE);
        chat.current_step = 'talking_to_staff';
        chat.handoff_at = new Date();
        chat.handoff_topic = 'Red Bridal Lehenga';
        await chat.save();
        await newSession('919000000002').save();

        const open = await listOpenChats();
        expect(open.map(s => `${s.phone_number}:${s.handoff_topic}`)).toEqual([`${PHONE}:Red Bridal Lehenga`]);
        expect(open[0]!.handoff_at).toBeInstanceOf(Date);

        memoryDb().sql(`update bot.sessions set updated_at = now() - interval '23 hours' where phone_number = '${PHONE}'`);
        await touchSession(PHONE);
        expect(await loadSession(PHONE)).not.toBeNull();

        await closeChat(PHONE);
        expect((await loadSession(PHONE))?.current_step).toBe('start');
        expect(await listOpenChats()).toEqual([]);
    });
});

describe('Inbox messages (bot.chat_messages)', () => {
    it('keeps the conversation in order and finds the latest messages', async () => {
        const since = new Date(Date.now() - 1000);
        await addChatMessage({ phone_number: PHONE, direction: 'in', text: 'Is this available in blue?' });
        await addChatMessage({ phone_number: PHONE, direction: 'in', text: '', media_id: '123456', media_type: 'image' });
        memoryDb().sql(`update bot.chat_messages set created_at = created_at - interval '1 minute'`);
        await addChatMessage({ phone_number: PHONE, direction: 'out', text: 'Yes, we can make it in blue.', sent_by: 'Rashmi' });
        await addChatMessage({ phone_number: '919000000002', direction: 'in', text: 'Hello' });

        const thread = await recentMessages(PHONE);
        expect(thread.map(m => m.direction)).toEqual(['in', 'in', 'out']);
        expect(thread[2]).toMatchObject({ sent_by: 'Rashmi', media_id: null });
        expect((await lastMessageSince(PHONE, since))?.text).toBe('Yes, we can make it in blue.');
        expect((await lastCustomerMessage(PHONE))?.direction).toBe('in');
        expect(await lastMessageSince(PHONE, new Date(Date.now() + 60000))).toBeNull();
    });
});
