import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app';
import { Order } from '../src/models/Order';
import { Customer } from '../src/models/Customer';
import { Session } from '../src/models/Session';
import { ChatMessage } from '../src/models/ChatMessage';
import { whatsappService } from '../src/services/whatsapp';
import { JWT_SECRET } from '../src/middleware/auth';

jest.mock('../src/services/whatsapp', () => ({
    whatsappService: {
        sendText: jest.fn().mockResolvedValue(true),
        downloadMedia: jest.fn()
    }
}));

const tokenFor = (role: 'admin' | 'delivery') =>
    `Bearer ${jwt.sign({ id: '1', username: role, name: role === 'admin' ? 'Rashmi' : 'Ravi', role }, JWT_SECRET)}`;
const ADMIN = tokenFor('admin');
const DELIVERY = tokenFor('delivery');

const PHONE = '910000000001';

function fakeOrder(fields: Record<string, any> = {}) {
    return {
        order_id: 'ab12cd34-1111-2222-3333-444455556666',
        customer_phone: PHONE,
        customer_name: 'Priya',
        service: 'Designer Blouse',
        booking_date: 'Wed, 4 Nov',
        booking_time: '01:00 PM - 03:00 PM',
        appointment_type: 'visit',
        price: 0,
        invoice_number: 'RB-20261102-1234',
        status: 'order_received',
        created_at: new Date('2026-11-02T06:00:00Z'),
        save: jest.fn().mockResolvedValue(undefined),
        ...fields
    };
}

const sorted = (value: any) => ({ sort: () => Promise.resolve(value) }) as any;

describe('Dashboard API', () => {
    beforeAll(() => jest.spyOn(console, 'log').mockImplementation(() => { }));
    afterEach(() => {
        jest.restoreAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => { });
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
        jest.spyOn(Order, 'find').mockReturnValue(sorted([fakeOrder()]));
        jest.spyOn(Customer, 'find').mockReturnValue(sorted([]));

        expect((await request(app).get('/api/orders').set('Authorization', DELIVERY)).status).toBe(200);
        expect((await request(app).get('/api/customers').set('Authorization', DELIVERY)).status).toBe(403);
        expect((await request(app).post('/api/broadcast').set('Authorization', DELIVERY)).status).toBe(403);
        expect((await request(app).get('/auth/staff').set('Authorization', DELIVERY)).status).toBe(403);
        expect((await request(app).get('/api/customers').set('Authorization', ADMIN)).status).toBe(200);
    });

    it('sends the customer a status update that fits a boutique visit', async () => {
        jest.spyOn(Order, 'findOneAndUpdate').mockResolvedValue(fakeOrder({ status: 'ready' }) as any);

        const res = await request(app).patch(`/api/orders/${fakeOrder().order_id}/status`)
            .set('Authorization', DELIVERY).send({ status: 'ready' });

        expect(res.status).toBe(200);
        expect(res.body.notified).toBe(true);
        const [to, msg] = (whatsappService.sendText as jest.Mock).mock.calls[0];
        expect(to).toBe(PHONE);
        expect(msg).toContain('Status: *Outfit Ready*');
        expect(msg).toContain('visit the boutique');
    });

    it('rejects an unknown status', async () => {
        const res = await request(app).patch('/api/orders/x/status').set('Authorization', ADMIN).send({ status: 'lost' });
        expect(res.status).toBe(400);
    });

    it('sets the price after measurement and sends it to the customer', async () => {
        const order = fakeOrder();
        jest.spyOn(Order, 'findOne').mockResolvedValue(order as any);

        const res = await request(app).patch(`/api/orders/${order.order_id}`).set('Authorization', ADMIN)
            .send({ price: 1850, notes: 'Bust 34, sleeve 9', notify: true });

        expect(res.status).toBe(200);
        expect(order.price).toBe(1850);
        expect(order.notes).toBe('Bust 34, sleeve 9');
        expect(order.save).toHaveBeenCalled();
        expect((whatsappService.sendText as jest.Mock).mock.calls[0][1]).toContain('Price: *₹1,850*');
    });

    it('saves notes without messaging the customer when the price is unchanged', async () => {
        jest.spyOn(Order, 'findOne').mockResolvedValue(fakeOrder({ price: 1850 }) as any);

        const res = await request(app).patch('/api/orders/x').set('Authorization', ADMIN)
            .send({ price: 1850, notes: 'Trial on Friday', notify: true });

        expect(res.body.notified).toBe(false);
        expect(whatsappService.sendText).not.toHaveBeenCalled();
    });

    it('refuses a negative price and keeps price changes for admins', async () => {
        jest.spyOn(Order, 'findOne').mockResolvedValue(fakeOrder() as any);
        expect((await request(app).patch('/api/orders/x').set('Authorization', ADMIN).send({ price: -5 })).status).toBe(400);
        expect((await request(app).patch('/api/orders/x').set('Authorization', DELIVERY).send({ price: 100 })).status).toBe(403);
    });

    it('escapes customer text on the printed receipt', async () => {
        jest.spyOn(Order, 'findOne').mockResolvedValue(fakeOrder({ customer_name: '<img src=x onerror=alert(1)>' }) as any);

        const res = await request(app).get('/api/orders/x/receipt').set('Authorization', ADMIN);
        expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(res.text).not.toContain('<img src=x');
    });

    it('lists open chats from customers who asked to talk to the team', async () => {
        const since = new Date('2026-11-02T06:00:00Z');
        jest.spyOn(Session, 'find').mockReturnValue(sorted([
            { phone_number: PHONE, name: 'Priya', handoff_topic: 'Red Bridal Lehenga', handoff_at: since, updated_at: since }
        ]));
        const last = { text: 'Is it available in blue?', direction: 'in', created_at: new Date('2026-11-02T06:05:00Z') };
        jest.spyOn(ChatMessage, 'findOne').mockReturnValue(sorted(last));

        const res = await request(app).get('/api/inbox').set('Authorization', ADMIN);

        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({ phone: PHONE, name: 'Priya', topic: 'Red Bridal Lehenga', waitingReply: true });
        expect(res.body[0].last.text).toBe('Is it available in blue?');
    });

    it('sends a reply from the inbox and keeps it in the conversation', async () => {
        jest.spyOn(ChatMessage, 'create').mockResolvedValue({} as any);
        const session = { save: jest.fn() };
        jest.spyOn(Session, 'findOne').mockResolvedValue(session as any);

        const res = await request(app).post(`/api/inbox/${PHONE}/reply`).set('Authorization', ADMIN).send({ text: 'Yes, we can make it in blue.' });

        expect(res.status).toBe(200);
        expect(whatsappService.sendText).toHaveBeenCalledWith(PHONE, 'Yes, we can make it in blue.');
        expect(ChatMessage.create).toHaveBeenCalledWith(expect.objectContaining({ direction: 'out', sent_by: 'Rashmi' }));
        expect(session.save).toHaveBeenCalled();
    });

    it('says so when WhatsApp refuses an inbox reply', async () => {
        (whatsappService.sendText as jest.Mock).mockResolvedValueOnce(false);
        jest.spyOn(ChatMessage, 'create').mockResolvedValue({} as any);

        const res = await request(app).post(`/api/inbox/${PHONE}/reply`).set('Authorization', ADMIN).send({ text: 'Hello' });

        expect(res.status).toBe(502);
        expect(res.body.error).toContain('24 hours');
        expect(ChatMessage.create).not.toHaveBeenCalled();
    });

    it('hands the chat back to the bot when it is resolved', async () => {
        const session = { current_step: 'talking_to_staff', save: jest.fn() };
        jest.spyOn(Session, 'findOne').mockResolvedValue(session as any);

        await request(app).post(`/api/inbox/${PHONE}/close`).set('Authorization', ADMIN).expect(200);
        expect(session.current_step).toBe('start');
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
});
