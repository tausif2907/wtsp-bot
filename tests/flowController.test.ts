import { flowController } from '../src/services/flowController';
import { whatsappService } from '../src/services/whatsapp';
import { upcomingOpenDays, slotsFor, dayLabel } from '../src/config/store';
import { loadSession } from '../src/db/sessions';
import { saveLeadName, listLeads } from '../src/db/leads';
import { createOrder, listOrders } from '../src/db/orders';
import { listCustomers } from '../src/db/customers';
import { recentMessages } from '../src/db/chats';
import { memoryDb } from './helpers/memoryDb';

// The bot's real SQL, against an in-memory copy of its Supabase tables
jest.mock('../src/db/pool', () => require('./helpers/memoryDb').mockPoolModule());

jest.mock('../src/services/whatsapp', () => ({
    whatsappService: {
        sendText: jest.fn(),
        sendInteractiveList: jest.fn(),
        sendInteractiveButtons: jest.fn(),
        sendImageLink: jest.fn(),
        uploadMedia: jest.fn().mockResolvedValue(null),
        sendDocument: jest.fn()
    }
}));

jest.mock('../src/utils/pdfGenerator', () => ({
    generateInvoiceHtml: jest.fn().mockResolvedValue('<html></html>'),
    generatePdfBuffer: jest.fn().mockResolvedValue(Buffer.from(''))
}));

// Stand-in for the website's product database
const PRODUCTS = [
    {
        id: 'p1', slug: 'maroon-raw-silk-blouse-ab12', name: 'Maroon Raw Silk Blouse', category: 'Blouses',
        price: 1499, mrp: 1999, description: 'Hand embroidered back', colour: 'Maroon', fabric: 'Raw silk', work: 'Zari',
        occasion: 'Festive', neckline: 'Sweetheart', sleeves: '', model_info: '', size_notes: '', return_policy: 'exchange',
        images: ['a.jpg', 'b.jpg', 'c.jpg'].map(f => `https://example.supabase.co/storage/v1/object/public/product-images/${f}`),
        sizes: [{ label: 'S', stock: 0 }, { label: 'M', stock: 2 }], is_sold_out: false, stitch_to_measure: true,
        stitch_price: 500, is_new_arrival: true, is_bestseller: false, created_at: '2026-11-01T10:00:00Z'
    },
    {
        id: 'p2', slug: 'red-bridal-lehenga-cd34', name: 'Red Bridal Lehenga', category: 'Lehenga',
        price: 24999, mrp: null, description: '', colour: 'Red', fabric: 'Velvet', work: 'Zardozi', occasion: 'Bridal',
        neckline: '', sleeves: '', model_info: '', size_notes: '', return_policy: 'none',
        images: [], sizes: [], is_sold_out: true, stitch_to_measure: false, stitch_price: 500,
        is_new_arrival: false, is_bestseller: false, created_at: '2026-10-01T10:00:00Z'
    }
];

// What the website's database holds right now; tests add and remove products here
let mockCatalog: any[] = [];

const newBlouse = (n: number) => ({
    ...PRODUCTS[0], id: `n${n}`, slug: `blouse-${n}`, name: `Blouse Design ${n}`, mrp: null, is_new_arrival: false, images: []
});

jest.mock('../src/services/catalog', () => {
    const actual = jest.requireActual('../src/services/catalog');
    return {
        ...actual,
        getProducts: jest.fn(async () => mockCatalog),
        getProduct: jest.fn(async (id: string) => mockCatalog.find(p => p.id === id)),
        getRating: jest.fn(async (id: string) => (id === 'p1' ? { average: 4.5, count: 2 } : undefined)),
        getAnnouncement: jest.fn(async () => ({ enabled: true, text: 'Festive offer: 10% off blouses', link: '' }))
    };
});

const PHONE = '910000000001';

const text = (body: string) => ({ from: PHONE, type: 'text', text: { body } });
const button = (id: string) => ({ from: PHONE, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });
const listItem = (id: string, title = id) => ({ from: PHONE, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });

const lastCall = (fn: any) => (fn as jest.Mock).mock.calls[(fn as jest.Mock).mock.calls.length - 1];

// Where the customer is in the conversation, as saved in bot.sessions
const session = async () => (await loadSession(PHONE)) as any;
const returningCustomer = () => saveLeadName(PHONE, 'Priya');
const asDay = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

describe('Rashmi Boutique conversation flow', () => {
    beforeEach(() => {
        // Only the 5-minute follow-up reminder needs fake time; the database still needs real ticks
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        memoryDb().reset();
        process.env.WEBSITE_URL = 'https://rashmi.example';
        process.env.OWNER_PHONE_NUMBER = '910000000099';
        mockCatalog = [...PRODUCTS];
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it('welcomes a new customer to Rashmi Boutique and asks for their name', async () => {
        await flowController.handleMessage(text('Hi'));

        expect((await session()).current_step).toBe('collecting_name');
        expect((whatsappService.sendText as jest.Mock).mock.calls[0][1]).toContain('Rashmi Boutique');
    });

    it('shows the main menu with the website offer after the customer gives their name', async () => {
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(text('Priya'));

        expect((await session()).current_step).toBe('main_menu');
        const [, body, list] = lastCall(whatsappService.sendInteractiveList);
        expect(body).toContain('Priya');
        expect(body).toContain('Festive offer');
        expect(list.rows.map((r: any) => r.id)).toEqual(['menu_shop', 'menu_book', 'menu_orders', 'menu_visit', 'menu_talk']);
    });

    it('greets a returning customer by name and skips the name question', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Namaste'));

        expect((await session()).current_step).toBe('main_menu');
        expect(lastCall(whatsappService.sendInteractiveList)[1]).toContain('Welcome back');
    });

    it('shows the real address and Tuesday closing on Visit the Boutique', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_visit'));

        const visitMsg = lastCall(whatsappService.sendText)[1];
        expect(visitMsg).toContain('Bistupur');
        expect(visitMsg).toContain('Tuesday: Closed');
    });

    it('browses the website collection and asks about a product', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        expect((await session()).current_step).toBe('browsing_categories');

        await flowController.handleMessage(listItem('cat:Blouses', 'Blouses'));
        expect((await session()).current_step).toBe('browsing_products');
        const rows = lastCall(whatsappService.sendInteractiveList)[2].rows;
        expect(rows[0]).toMatchObject({ id: 'prod:p1', title: 'Maroon Raw Silk Blouse' });
        expect(rows[0].description).toContain('25% off');

        await flowController.handleMessage(listItem('prod:p1'));
        const [, photo, caption] = lastCall(whatsappService.sendImageLink);
        expect(photo).toContain('product-images/a.jpg');
        expect(caption).toContain('Sizes in stock: M');
        expect(caption).toContain('https://rashmi.example/shop/maroon-raw-silk-blouse-ab12');

        await flowController.handleMessage(button('prod_ask'));
        expect((await session()).current_step).toBe('talking_to_staff');
        const ownerAlert = (whatsappService.sendText as jest.Mock).mock.calls.find(c => c[0] === '910000000099');
        expect(ownerAlert[1]).toContain('Maroon Raw Silk Blouse');
    });

    it('opens a category tapped in an earlier list, even while viewing a product', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        await flowController.handleMessage(listItem('cat:Blouses', 'Blouses'));
        await flowController.handleMessage(listItem('prod:p1'));
        expect((await session()).current_step).toBe('viewing_product');

        await flowController.handleMessage(listItem('cat:Lehenga', 'Lehenga'));
        expect((await session()).current_step).toBe('browsing_products');
        expect(lastCall(whatsappService.sendInteractiveList)[2].rows[0].id).toBe('prod:p2');
    });

    it('marks sold-out products and sends text when a product has no photo', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        await flowController.handleMessage(listItem('cat:Lehenga', 'Lehenga'));
        expect(lastCall(whatsappService.sendInteractiveList)[2].rows[0].description).toContain('Sold out');

        await flowController.handleMessage(listItem('prod:p2'));
        expect(whatsappService.sendImageLink).not.toHaveBeenCalled();
        expect(lastCall(whatsappService.sendText)[1]).toContain('sold out');
    });

    it('lists new arrivals and offers first, then categories in the website order', async () => {
        mockCatalog = [PRODUCTS[1], PRODUCTS[0]]; // newest product is a lehenga
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));

        const rows = lastCall(whatsappService.sendInteractiveList)[2].rows;
        expect(rows.map((r: any) => r.id)).toEqual(['col:new', 'col:sale', 'cat:Blouses', 'cat:Lehenga']);
        expect(rows[1]).toMatchObject({ title: '🏷️ On Sale', description: '1 design' });

        await flowController.handleMessage(listItem('col:sale', '🏷️ On Sale'));
        expect(lastCall(whatsappService.sendInteractiveList)[2].rows[0].id).toBe('prod:p1');
    });

    it('shows a product added on the website the next time a customer browses', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        expect(lastCall(whatsappService.sendInteractiveList)[1]).toContain('2 designs available');

        mockCatalog = [{ ...newBlouse(1), name: 'Ivory Chikankari Blouse' }, ...mockCatalog];
        await flowController.handleMessage(listItem('cat:Blouses', 'Blouses'));

        const rows = lastCall(whatsappService.sendInteractiveList)[2].rows;
        expect(rows[0]).toMatchObject({ id: 'prod:n1', title: 'Ivory Chikankari Blouse' });
        expect(rows.map((r: any) => r.id)).toContain('prod:p1');
    });

    it('pages through a category with more designs than one WhatsApp list holds', async () => {
        mockCatalog = Array.from({ length: 12 }, (_, i) => newBlouse(i + 1));
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        await flowController.handleMessage(listItem('cat:Blouses', 'Blouses'));

        let [, body, list] = lastCall(whatsappService.sendInteractiveList);
        expect(list.rows).toHaveLength(10);
        expect(list.rows[8]).toMatchObject({ id: 'more:1:cat:Blouses', description: 'Designs 9–12 of 12' });
        expect(list.rows[9].id).toBe('back_categories');
        expect(body).toContain('Showing 1–8 of 12');

        await flowController.handleMessage(listItem('more:1:cat:Blouses'));
        [, body, list] = lastCall(whatsappService.sendInteractiveList);
        expect(list.rows.map((r: any) => r.id)).toEqual(['prod:n9', 'prod:n10', 'prod:n11', 'prod:n12', 'back_categories']);
        expect(body).toContain('Showing 9–12 of 12');

        // "More Designs" on a product goes back to the page the customer was on
        await flowController.handleMessage(listItem('prod:n10'));
        await flowController.handleMessage(button('prod_more'));
        expect(lastCall(whatsappService.sendInteractiveList)[2].rows[0].id).toBe('prod:n9');
    });

    it('shows the rating, neckline and return policy, and sends the other photos on request', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        await flowController.handleMessage(listItem('cat:Blouses', 'Blouses'));
        await flowController.handleMessage(listItem('prod:p1'));

        const caption = lastCall(whatsappService.sendImageLink)[2];
        expect(caption).toContain('⭐ 4.5 (2 reviews)');
        expect(caption).toContain('Neckline: Sweetheart');
        expect(caption).toContain('Easy exchange within 3 days');
        const buttons = lastCall(whatsappService.sendInteractiveButtons)[2];
        expect(buttons.map((b: any) => b.id)).toEqual(['prod_ask', 'prod_photos', 'prod_more']);
        expect(buttons[1].title).toBe('More Photos (2)');

        (whatsappService.sendImageLink as jest.Mock).mockClear();
        await flowController.handleMessage(button('prod_photos'));
        const photos = (whatsappService.sendImageLink as jest.Mock).mock.calls;
        expect(photos.map(c => c[1])).toEqual([expect.stringContaining('b.jpg'), expect.stringContaining('c.jpg')]);
        expect(photos[1][2]).toBe('Maroon Raw Silk Blouse (3/3)');
        expect(lastCall(whatsappService.sendInteractiveButtons)[2].map((b: any) => b.id)).toEqual(['prod_ask', 'prod_more', 'prod_menu']);
    });

    it('tells the customer when a design was removed from the website', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        await flowController.handleMessage(listItem('cat:Blouses', 'Blouses'));

        mockCatalog = mockCatalog.filter(p => p.id !== 'p1');
        await flowController.handleMessage(listItem('prod:p1'));

        expect((whatsappService.sendText as jest.Mock).mock.calls.some(c => c[1].includes('no longer in our collection'))).toBe(true);
        expect(whatsappService.sendImageLink).not.toHaveBeenCalled();
        expect((await session()).current_step).toBe('browsing_categories'); // the blouse shelf is empty now
    });

    it('stays quiet while the boutique team is chatting, until the customer says Hi', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_talk'));
        expect((await session()).current_step).toBe('talking_to_staff');

        (whatsappService.sendText as jest.Mock).mockClear();
        await flowController.handleMessage(text('I want a blouse like this'));
        await flowController.handleMessage({ from: PHONE, type: 'image', image: { id: '123456', caption: 'This neckline' } });
        expect(whatsappService.sendText).not.toHaveBeenCalled();

        // Saved for the dashboard inbox, since the team can't read the bot's number in the WhatsApp app
        const inbox = await recentMessages(PHONE);
        expect(inbox).toEqual([
            expect.objectContaining({ direction: 'in', text: 'I want a blouse like this', media_id: null }),
            expect.objectContaining({ direction: 'in', text: 'This neckline', media_id: '123456', media_type: 'image' })
        ]);
        expect((await session()).handoff_at).toBeInstanceOf(Date);
    });

    it('shows the customer their bookings with status and price', async () => {
        await returningCustomer();
        const booked = { customer_phone: PHONE, customer_name: 'Priya', invoice_number: 'RB-20261104-1000', status: 'order_received' };
        await createOrder({ ...booked, order_id: 'ab12cd34-0000', service: 'Designer Blouse', appointment_type: 'visit', booking_date: 'Wed, 4 Nov', booking_time: '01:00 PM - 03:00 PM', price: 1800, status: 'ready' });
        await createOrder({ ...booked, order_id: 'ef56ab78-0000', service: 'Lehenga Choli', appointment_type: 'pickup', booking_date: 'Thu, 5 Nov', booking_time: '05:00 PM - 07:00 PM', price: 0 });
        await createOrder({ ...booked, order_id: 'someone-else', customer_phone: '919000000002', service: 'Custom Skirt', appointment_type: 'visit', booking_date: 'Thu, 5 Nov', booking_time: '11:00 AM - 01:00 PM', price: 0 });
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_orders'));

        const msg = lastCall(whatsappService.sendText)[1];
        expect(msg).toContain('*AB12CD34* · Outfit Ready');
        expect(msg).toContain('Price: ₹1,800');
        expect(msg).toContain('Pickup: Thu, 5 Nov');
        expect(msg).toContain('Price: shared after measurement');
        expect(msg).not.toContain('Custom Skirt'); // another customer's booking
    });

    it('offers to book when the customer has no bookings yet', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_orders'));

        const [, body, buttons] = lastCall(whatsappService.sendInteractiveButtons);
        expect(body).toContain('no bookings');
        expect(buttons.map((b: any) => b.id)).toContain('menu_book');
    });

    it('asks again when a day tapped in an old list has passed', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_book'));
        await flowController.handleMessage(listItem('service_blouse'));
        await flowController.handleMessage(button('proceed_checkout'));
        await flowController.handleMessage(button('appt_visit'));
        await flowController.handleMessage(listItem('date_2020-01-01', 'Wed, 1 Jan'));

        expect((await session()).current_step).toBe('selecting_date');
        expect((whatsappService.sendText as jest.Mock).mock.calls.some(c => c[1].includes('no longer available'))).toBe(true);
        expect(lastCall(whatsappService.sendInteractiveList)[2].title).toBe('Available Days');
    });

    it('books a measurement visit at the boutique without asking for an address', async () => {
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(text('Priya'));
        await flowController.handleMessage(listItem('menu_book'));
        expect((await session()).current_step).toBe('selecting_service');

        await flowController.handleMessage(listItem('service_blouse'));
        await flowController.handleMessage(button('add_more_items'));
        await flowController.handleMessage(listItem('service_lehenga'));
        expect((await session()).cart.map((i: any) => i.service)).toEqual(['Designer Blouse', 'Lehenga Choli']);

        await flowController.handleMessage(button('proceed_checkout'));
        await flowController.handleMessage(button('appt_visit'));
        const day = upcomingOpenDays(7)[1]!;
        await flowController.handleMessage(listItem(day.id, day.title));
        await flowController.handleMessage(listItem('time_13', '01:00 PM - 03:00 PM'));
        expect((await session()).current_step).toBe('confirming_booking');
        expect(lastCall(whatsappService.sendInteractiveButtons)[1]).toContain('Price will be shared after measurement');

        await flowController.handleMessage(button('confirm_booking'));

        const [order] = await listOrders();
        expect(order).toMatchObject({
            customer_name: 'Priya',
            service: 'Designer Blouse, Lehenga Choli',
            appointment_type: 'visit',
            price: 0,
            booking_time: '01:00 PM - 03:00 PM',
            // Stored without "Today"/"Tomorrow", which would be wrong the next day
            booking_date: dayLabel(day.id.slice(5)),
            invoice_number: expect.stringMatching(/^RB-\d{8}-\d{4}$/)
        });
        expect(asDay(order!.appointment_day)).toBe(day.id.slice(5));
        expect(order!.booking_date).not.toMatch(/Today|Tomorrow/);
        expect(order!.address).toBeNull();

        // The conversation is finished and the contact is now a registered customer
        expect(await session()).toBeNull();
        expect((await listLeads())[0]).toMatchObject({ phone_number: PHONE, name: 'Priya', type: 'registered' });
        expect((await listCustomers())[0]).toMatchObject({ phone_number: PHONE, name: 'Priya', address: null });
    });

    it('books a home pickup with location and address', async () => {
        await returningCustomer();
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_book'));
        await flowController.handleMessage(listItem('service_salwar'));
        await flowController.handleMessage(button('proceed_checkout'));
        await flowController.handleMessage(button('appt_pickup'));
        const day = upcomingOpenDays(7)[1]!;
        await flowController.handleMessage(listItem(day.id, day.title));
        await flowController.handleMessage(listItem('time_17', '05:00 PM - 07:00 PM'));
        expect((await session()).current_step).toBe('sharing_location');

        await flowController.handleMessage({ from: PHONE, type: 'location', location: { latitude: 22.79, longitude: 86.18 } });
        await flowController.handleMessage(text('Flat 4, Sakchi, Jamshedpur 831001'));
        await flowController.handleMessage(button('confirm_booking'));

        expect((await listOrders())[0]).toMatchObject({
            appointment_type: 'pickup',
            address: 'Flat 4, Sakchi, Jamshedpur 831001',
            latitude: 22.79
        });
        expect((await listCustomers())[0]).toMatchObject({ address: 'Flat 4, Sakchi, Jamshedpur 831001', location_lng: 86.18 });
    });
});

describe('Boutique opening days and slots', () => {
    afterEach(() => jest.useRealTimers());

    it('never offers a Tuesday', () => {
        // Monday 2 Nov 2026, 10:00 AM in India
        jest.useFakeTimers().setSystemTime(new Date('2026-11-02T04:30:00Z'));
        const days = upcomingOpenDays(7);
        expect(days).toHaveLength(7);
        expect(days.map(d => d.id)).not.toContain('date_2026-11-03');
        expect(days[0]!.title).toMatch(/^Today, Mon/);
    });

    it('drops today once the last slot has started and hides past slots', () => {
        // Sunday 1 Nov 2026, 3:30 PM in India
        jest.useFakeTimers().setSystemTime(new Date('2026-11-01T10:00:00Z'));
        expect(slotsFor('date_2026-11-01').map(s => s.start)).toEqual([17, 19]);
        expect(slotsFor('date_2026-11-02')).toHaveLength(5);

        // Sunday 1 Nov 2026, 8:00 PM in India
        jest.useFakeTimers().setSystemTime(new Date('2026-11-01T14:30:00Z'));
        expect(upcomingOpenDays(3)[0]!.id).toBe('date_2026-11-02');
    });
});
