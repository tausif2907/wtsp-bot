import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app';
import { whatsappService } from '../src/services/whatsapp';
import { JWT_SECRET } from '../src/middleware/auth';
import { createStaff, findStaffForLogin, checkPassword } from '../src/db/staff';
import { createOrder, findOrder, NewOrder } from '../src/db/orders';
import { newSession, loadSession } from '../src/db/sessions';
import { addChatMessage, recentMessages } from '../src/db/chats';
import { upsertCustomer } from '../src/db/customers';
import { memoryDb } from './helpers/memoryDb';

// The bot's real SQL, against an in-memory copy of its Supabase tables
jest.mock('../src/db/pool', () => require('./helpers/memoryDb').mockPoolModule());

jest.mock('../src/services/whatsapp', () => ({
    whatsappService: {
        sendText: jest.fn().mockResolvedValue(true),
        downloadMedia: jest.fn()
    }
}));

const PHONE = '910000000001';
const ORDER_ID = 'ab12cd34-1111-2222-3333-444455556666';

const booking = (fields: Partial<NewOrder> = {}): NewOrder => ({
    order_id: ORDER_ID,
    customer_phone: PHONE,
    customer_name: 'Priya',
    service: 'Designer Blouse',
    booking_date: 'Wed, 4 Nov',
    booking_time: '01:00 PM - 03:00 PM',
    appointment_day: '2026-11-04',
    appointment_type: 'visit',
    price: 0,
    invoice_number: 'RB-20261102-1234',
    status: 'order_received',
    ...fields
});

let ADMIN: string;
let DELIVERY: string;
let raviId: string;

const bearer = (account: { id: string; username: string; name: string; role: string }) =>
    `Bearer ${jwt.sign({ id: account.id, username: account.username, name: account.name, role: account.role }, JWT_SECRET)}`;

describe('Dashboard API', () => {
    beforeAll(() => jest.spyOn(console, 'log').mockImplementation(() => { }));

    beforeEach(async () => {
        memoryDb().reset();
        (whatsappService.sendText as jest.Mock).mockClear().mockResolvedValue(true);
        const admin = await createStaff({ name: 'Rashmi', username: 'rashmi', password: 'boutique-2026', role: 'admin' });
        const ravi = await createStaff({ name: 'Ravi', username: 'ravi', password: 'deliver-2026', role: 'delivery' });
        raviId = ravi.id;
        ADMIN = bearer(admin);
        DELIVERY = bearer(ravi);
    });

    it('turns away requests without a login', async () => {
        const res = await request(app).get('/api/orders');
        expect(res.status).toBe(401);
    });

    it('turns away a login signed with the old built-in secret', async () => {
        const forged = jwt.sign({ id: '1', username: 'x', name: 'x', role: 'admin' }, 'tailor_dashboard_secret_key_2024');
        const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${forged}`);
        expect(res.status).toBe(401);
    });

    it('lets delivery staff see orders but not customers, broadcasts or staff accounts', async () => {
        await createOrder(booking());
        await upsertCustomer(PHONE, { name: 'Priya' });

        const orders = await request(app).get('/api/orders').set('Authorization', DELIVERY);
        expect(orders.status).toBe(200);
        expect(orders.body[0]).toMatchObject({ order_id: ORDER_ID, customer_name: 'Priya' });
        expect((await request(app).get('/api/customers').set('Authorization', DELIVERY)).status).toBe(403);
        expect((await request(app).post('/api/broadcast').set('Authorization', DELIVERY)).status).toBe(403);
        expect((await request(app).get('/auth/staff').set('Authorization', DELIVERY)).status).toBe(403);

        const customers = await request(app).get('/api/customers').set('Authorization', ADMIN);
        expect(customers.body.map((c: any) => c.name)).toEqual(['Priya']);
        const staff = await request(app).get('/auth/staff').set('Authorization', ADMIN);
        expect(staff.body).toEqual([expect.objectContaining({ username: 'ravi', role: 'delivery' })]);
        expect(staff.body[0]).not.toHaveProperty('password_hash');
    });

    it('sends the customer a status update that fits a boutique visit', async () => {
        await createOrder(booking());

        const res = await request(app).patch(`/api/orders/${ORDER_ID}/status`).set('Authorization', DELIVERY).send({ status: 'ready' });

        expect(res.status).toBe(200);
        expect(res.body.notified).toBe(true);
        expect((await findOrder(ORDER_ID))?.status).toBe('ready');
        const [to, msg] = (whatsappService.sendText as jest.Mock).mock.calls[0];
        expect(to).toBe(PHONE);
        expect(msg).toContain('Status: *Outfit Ready*');
        expect(msg).toContain('visit the boutique');
    });

    it('rejects an unknown status and an unknown order', async () => {
        expect((await request(app).patch('/api/orders/x/status').set('Authorization', ADMIN).send({ status: 'lost' })).status).toBe(400);
        expect((await request(app).patch('/api/orders/x/status').set('Authorization', ADMIN).send({ status: 'ready' })).status).toBe(404);
    });

    it('sets the price after measurement and sends it to the customer', async () => {
        await createOrder(booking());

        const res = await request(app).patch(`/api/orders/${ORDER_ID}`).set('Authorization', ADMIN)
            .send({ price: 1850, notes: 'Bust 34, sleeve 9', notify: true });

        expect(res.status).toBe(200);
        expect(res.body.notified).toBe(true);
        expect(await findOrder(ORDER_ID)).toMatchObject({ price: 1850, notes: 'Bust 34, sleeve 9' });
        expect((whatsappService.sendText as jest.Mock).mock.calls[0][1]).toContain('Price: *₹1,850*');
    });

    it('saves notes without messaging the customer when the price is unchanged', async () => {
        await createOrder(booking({ price: 1850 }));

        const res = await request(app).patch(`/api/orders/${ORDER_ID}`).set('Authorization', ADMIN)
            .send({ price: 1850, notes: 'Trial on Friday', notify: true });

        expect(res.body.notified).toBe(false);
        expect((await findOrder(ORDER_ID))?.notes).toBe('Trial on Friday');
        expect(whatsappService.sendText).not.toHaveBeenCalled();
    });

    it('refuses a negative price and keeps price changes for admins', async () => {
        await createOrder(booking());
        expect((await request(app).patch(`/api/orders/${ORDER_ID}`).set('Authorization', ADMIN).send({ price: -5 })).status).toBe(400);
        expect((await request(app).patch(`/api/orders/${ORDER_ID}`).set('Authorization', DELIVERY).send({ price: 100 })).status).toBe(403);
        expect((await findOrder(ORDER_ID))?.price).toBe(0);
    });

    it('escapes customer text on the printed receipt', async () => {
        await createOrder(booking({ customer_name: '<img src=x onerror=alert(1)>' }));

        const res = await request(app).get(`/api/orders/${ORDER_ID}/receipt`).set('Authorization', ADMIN);
        expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(res.text).not.toContain('<img src=x');
    });

    it('lists open chats from customers who asked to talk to the team', async () => {
        const chat = newSession(PHONE);
        chat.current_step = 'talking_to_staff';
        chat.name = 'Priya';
        chat.handoff_topic = 'Red Bridal Lehenga';
        chat.handoff_at = new Date(Date.now() - 60000);
        await chat.save();
        await addChatMessage({ phone_number: PHONE, direction: 'in', text: 'Is it available in blue?' });

        const res = await request(app).get('/api/inbox').set('Authorization', ADMIN);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({ phone: PHONE, name: 'Priya', topic: 'Red Bridal Lehenga', waitingReply: true });
        expect(res.body[0].last.text).toBe('Is it available in blue?');
    });

    it('sends a reply from the inbox and keeps it in the conversation', async () => {
        const chat = newSession(PHONE);
        chat.current_step = 'talking_to_staff';
        await chat.save();

        const res = await request(app).post(`/api/inbox/${PHONE}/reply`).set('Authorization', ADMIN).send({ text: 'Yes, we can make it in blue.' });

        expect(res.status).toBe(200);
        expect(whatsappService.sendText).toHaveBeenCalledWith(PHONE, 'Yes, we can make it in blue.');
        expect(await recentMessages(PHONE)).toEqual([expect.objectContaining({ direction: 'out', sent_by: 'Rashmi', text: 'Yes, we can make it in blue.' })]);

        const thread = await request(app).get(`/api/inbox/${PHONE}`).set('Authorization', ADMIN);
        expect(thread.body).toMatchObject({ open: true, messages: [expect.objectContaining({ direction: 'out' })] });
    });

    it('says so when WhatsApp refuses an inbox reply', async () => {
        (whatsappService.sendText as jest.Mock).mockResolvedValueOnce(false);

        const res = await request(app).post(`/api/inbox/${PHONE}/reply`).set('Authorization', ADMIN).send({ text: 'Hello' });

        expect(res.status).toBe(502);
        expect(res.body.error).toContain('24 hours');
        expect(await recentMessages(PHONE)).toEqual([]);
    });

    it('hands the chat back to the bot when it is resolved', async () => {
        const chat = newSession(PHONE);
        chat.current_step = 'talking_to_staff';
        await chat.save();

        await request(app).post(`/api/inbox/${PHONE}/close`).set('Authorization', ADMIN).expect(200);
        expect((await loadSession(PHONE))?.current_step).toBe('start');
    });

    it('only passes through customer files that cannot run scripts', async () => {
        expect((await request(app).get('/api/media/abc').set('Authorization', ADMIN)).status).toBe(400);

        (whatsappService.downloadMedia as jest.Mock).mockResolvedValueOnce({ data: Buffer.from('<script>'), mimeType: 'text/html' });
        expect((await request(app).get('/api/media/123').set('Authorization', ADMIN)).status).toBe(415);

        (whatsappService.downloadMedia as jest.Mock).mockResolvedValueOnce({ data: Buffer.from('jpeg'), mimeType: 'image/jpeg' });
        const ok = await request(app).get('/api/media/123').set('Authorization', ADMIN);
        expect(ok.status).toBe(200);
        expect(ok.headers['content-type']).toBe('image/jpeg');
    });

    it('locks out a revoked staff account straight away, not after its 7-day login runs out', async () => {
        expect((await request(app).get('/api/orders').set('Authorization', DELIVERY)).status).toBe(200);
        await request(app).delete(`/auth/staff/${raviId}`).set('Authorization', ADMIN).expect(200);

        expect((await request(app).get('/api/orders').set('Authorization', DELIVERY)).status).toBe(401);
        expect((await request(app).get('/auth/verify').set('Authorization', DELIVERY)).status).toBe(401);
    });

    it('lets an admin add delivery staff, but not another admin', async () => {
        const add = (body: object) => request(app).post('/auth/signup').set('Authorization', ADMIN).send(body);
        expect((await add({ name: 'Sita', username: 'sita', password: 'deliver-2026', role: 'delivery' })).status).toBe(201);
        expect((await add({ name: 'Sita', username: 'SITA', password: 'deliver-2026', role: 'delivery' })).body.error).toContain('already exists');
        expect((await add({ name: 'Boss', username: 'boss', password: 'boutique-2026', role: 'admin' })).status).toBe(403);
        expect((await request(app).post('/auth/signup').set('Authorization', DELIVERY).send({ name: 'X', username: 'x', password: 'deliver-2026' })).status).toBe(403);
    });

    it('changes the password only when the current one is right', async () => {
        const send = (body: object) => request(app).post('/auth/password').set('Authorization', ADMIN).send(body);
        expect((await send({ currentPassword: 'guess', newPassword: 'new-password-1' })).status).toBe(400);
        expect((await send({ currentPassword: 'boutique-2026', newPassword: 'short' })).status).toBe(400);
        expect((await send({ currentPassword: 'boutique-2026', newPassword: 'new-password-1' })).status).toBe(200);

        const login = await request(app).post('/auth/login').send({ username: 'rashmi', password: 'new-password-1' });
        expect(login.status).toBe(200);
        expect(login.body).toMatchObject({ name: 'Rashmi', role: 'admin', token: expect.any(String) });
    });

    it('slows down password guessing on the login page', async () => {
        const attempt = () => request(app).post('/auth/login').send({ username: 'owner-guess-test', password: 'wrong' });

        for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
        const locked = await attempt();
        expect(locked.status).toBe(429);
        expect(locked.body.error).toContain('Too many wrong passwords');
    });

    it('reports whether the bot is in sync with the online store', async () => {
        const res = await request(app).get('/api/catalog').set('Authorization', ADMIN);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ configured: false, products: [], error: '' });
    });
});

describe('First-time setup on an empty database', () => {
    let logged: string[];

    beforeEach(() => {
        memoryDb().reset();
        logged = [];
        jest.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.join(' ')); });
    });
    afterEach(() => jest.restoreAllMocks());

    const codeFromConsole = () => /setup code: (\w{4}-\w{4})/.exec(logged.join('\n'))?.[1];

    it('creates the first admin only with the code printed in the server console', async () => {
        const { announceSetupIfNeeded } = await import('../src/routes/authRoutes');
        await announceSetupIfNeeded();
        const code = codeFromConsole();
        expect(code).toMatch(/^\w{4}-\w{4}$/);

        expect((await request(app).get('/auth/setup')).body).toEqual({ needed: true });

        const wrong = await request(app).post('/auth/signup').send({ setupCode: 'AAAA-AAAA', name: 'Intruder', username: 'intruder', password: 'let-me-in-123' });
        expect(wrong.status).toBe(403);

        const res = await request(app).post('/auth/signup').send({ setupCode: code!.toLowerCase(), name: 'Rashmi', username: 'Rashmi', password: 'boutique-2026', role: 'delivery' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ username: 'rashmi', role: 'admin', token: expect.any(String) });

        // From now on the code is gone and new accounts need an admin login
        expect((await request(app).get('/auth/setup')).body).toEqual({ needed: false });
        const again = await request(app).post('/auth/signup').send({ setupCode: code, name: 'X', username: 'x', password: 'let-me-in-123' });
        expect(again.status).toBe(401);
        expect(await checkPassword((await findStaffForLogin('rashmi'))!, 'boutique-2026')).toBe(true);
    });

    it('prints a fresh code after ten wrong guesses', async () => {
        const { announceSetupIfNeeded } = await import('../src/routes/authRoutes');
        await announceSetupIfNeeded();
        const first = codeFromConsole();

        for (let i = 0; i < 10; i++) {
            await request(app).post('/auth/signup').send({ setupCode: `ZZZZ-${String(i).padStart(4, '0')}`, name: 'X', username: 'x', password: 'let-me-in-123' });
        }
        const codes = logged.join('\n').match(/setup code: (\w{4}-\w{4})/g) || [];
        expect(codes.length).toBeGreaterThan(1);
        expect(codes[codes.length - 1]).not.toContain(first!);

        const stale = await request(app).post('/auth/signup').send({ setupCode: first, name: 'Rashmi', username: 'rashmi', password: 'boutique-2026' });
        expect(stale.status).toBe(403);
    });
});
