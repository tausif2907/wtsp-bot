import { flowController } from '../src/services/flowController';
import { Session } from '../src/models/Session';
import { Customer } from '../src/models/Customer';
import { Order } from '../src/models/Order';
import { Lead } from '../src/models/Lead';
import { whatsappService } from '../src/services/whatsapp';
import { upcomingOpenDays, slotsFor } from '../src/config/store';

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
        occasion: 'Festive', images: ['https://example.supabase.co/storage/v1/object/public/product-images/a.jpg'],
        sizes: [{ label: 'S', stock: 0 }, { label: 'M', stock: 2 }], is_sold_out: false, stitch_to_measure: true,
        stitch_price: 500, is_new_arrival: true, is_bestseller: false
    },
    {
        id: 'p2', slug: 'red-bridal-lehenga-cd34', name: 'Red Bridal Lehenga', category: 'Lehenga',
        price: 24999, mrp: null, description: '', colour: 'Red', fabric: 'Velvet', work: 'Zardozi', occasion: 'Bridal',
        images: [], sizes: [], is_sold_out: true, stitch_to_measure: false, stitch_price: 500,
        is_new_arrival: false, is_bestseller: false
    }
];

jest.mock('../src/services/catalog', () => {
    const actual = jest.requireActual('../src/services/catalog');
    return {
        ...actual,
        getProducts: jest.fn(async () => PRODUCTS),
        getProduct: jest.fn(async (id: string) => PRODUCTS.find(p => p.id === id)),
        getCategories: jest.fn(async () => [{ name: 'Blouses', count: 1 }, { name: 'Lehenga', count: 1 }]),
        getAnnouncement: jest.fn(async () => ({ enabled: true, text: 'Festive offer: 10% off blouses', link: '' }))
    };
});

const PHONE = '910000000001';

const text = (body: string) => ({ from: PHONE, type: 'text', text: { body } });
const button = (id: string) => ({ from: PHONE, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } });
const listItem = (id: string, title = id) => ({ from: PHONE, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });

const lastCall = (fn: any) => (fn as jest.Mock).mock.calls[(fn as jest.Mock).mock.calls.length - 1];

describe('Rashmi Boutique conversation flow', () => {
    let stored: any;
    let leadName: string;

    beforeEach(() => {
        jest.useFakeTimers();
        stored = null;
        leadName = '';
        process.env.WEBSITE_URL = 'https://rashmi.example';
        process.env.OWNER_PHONE_NUMBER = '910000000099';

        jest.spyOn(Session, 'findOne').mockImplementation(() => Promise.resolve(stored) as any);
        jest.spyOn(Session.prototype, 'save').mockImplementation(function (this: any) {
            stored = this;
            return Promise.resolve(this);
        });
        jest.spyOn(Session, 'deleteOne').mockImplementation(() => { stored = null; return Promise.resolve({}) as any; });
        jest.spyOn(Lead, 'findOne').mockImplementation(() => Promise.resolve(leadName ? { name: leadName } : null) as any);
        jest.spyOn(Lead, 'findOneAndUpdate').mockImplementation(((_: any, update: any) => {
            const name = update?.$set?.name ?? update?.name;
            if (name) leadName = name;
            return Promise.resolve({});
        }) as any);
        jest.spyOn(Customer, 'findOneAndUpdate').mockResolvedValue({} as any);
        jest.spyOn(Order, 'create').mockResolvedValue({} as any);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it('welcomes a new customer to Rashmi Boutique and asks for their name', async () => {
        await flowController.handleMessage(text('Hi'));

        expect(stored.current_step).toBe('collecting_name');
        expect((whatsappService.sendText as jest.Mock).mock.calls[0][1]).toContain('Rashmi Boutique');
    });

    it('shows the main menu with the website offer after the customer gives their name', async () => {
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(text('Priya'));

        expect(stored.current_step).toBe('main_menu');
        const [, body, list] = lastCall(whatsappService.sendInteractiveList);
        expect(body).toContain('Priya');
        expect(body).toContain('Festive offer');
        expect(list.rows.map((r: any) => r.id)).toEqual(['menu_shop', 'menu_book', 'menu_visit', 'menu_talk']);
    });

    it('greets a returning customer by name and skips the name question', async () => {
        leadName = 'Priya';
        await flowController.handleMessage(text('Namaste'));

        expect(stored.current_step).toBe('main_menu');
        expect(lastCall(whatsappService.sendInteractiveList)[1]).toContain('Welcome back');
    });

    it('shows the real address and Tuesday closing on Visit the Boutique', async () => {
        leadName = 'Priya';
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_visit'));

        const visitMsg = lastCall(whatsappService.sendText)[1];
        expect(visitMsg).toContain('Bistupur');
        expect(visitMsg).toContain('Tuesday: Closed');
    });

    it('browses the website collection and asks about a product', async () => {
        leadName = 'Priya';
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        expect(stored.current_step).toBe('browsing_categories');

        await flowController.handleMessage(listItem('cat:Blouses', 'Blouses'));
        expect(stored.current_step).toBe('browsing_products');
        const rows = lastCall(whatsappService.sendInteractiveList)[2].rows;
        expect(rows[0]).toMatchObject({ id: 'prod:p1', title: 'Maroon Raw Silk Blouse' });
        expect(rows[0].description).toContain('25% off');

        await flowController.handleMessage(listItem('prod:p1'));
        const [, photo, caption] = lastCall(whatsappService.sendImageLink);
        expect(photo).toContain('product-images/a.jpg');
        expect(caption).toContain('Sizes in stock: M');
        expect(caption).toContain('https://rashmi.example/shop/maroon-raw-silk-blouse-ab12');

        await flowController.handleMessage(button('prod_ask'));
        expect(stored.current_step).toBe('talking_to_staff');
        const ownerAlert = (whatsappService.sendText as jest.Mock).mock.calls.find(c => c[0] === '910000000099');
        expect(ownerAlert[1]).toContain('Maroon Raw Silk Blouse');
    });

    it('opens a category tapped in an earlier list, even while viewing a product', async () => {
        leadName = 'Priya';
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        await flowController.handleMessage(listItem('cat:Blouses', 'Blouses'));
        await flowController.handleMessage(listItem('prod:p1'));
        expect(stored.current_step).toBe('viewing_product');

        await flowController.handleMessage(listItem('cat:Lehenga', 'Lehenga'));
        expect(stored.current_step).toBe('browsing_products');
        expect(lastCall(whatsappService.sendInteractiveList)[2].rows[0].id).toBe('prod:p2');
    });

    it('marks sold-out products and sends text when a product has no photo', async () => {
        leadName = 'Priya';
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_shop'));
        await flowController.handleMessage(listItem('cat:Lehenga', 'Lehenga'));
        expect(lastCall(whatsappService.sendInteractiveList)[2].rows[0].description).toContain('Sold out');

        await flowController.handleMessage(listItem('prod:p2'));
        expect(whatsappService.sendImageLink).not.toHaveBeenCalled();
        expect(lastCall(whatsappService.sendText)[1]).toContain('sold out');
    });

    it('stays quiet while the boutique team is chatting, until the customer says Hi', async () => {
        leadName = 'Priya';
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_talk'));
        expect(stored.current_step).toBe('talking_to_staff');

        (whatsappService.sendText as jest.Mock).mockClear();
        await flowController.handleMessage(text('I want a blouse like this'));
        expect(whatsappService.sendText).not.toHaveBeenCalled();
    });

    it('books a measurement visit at the boutique without asking for an address', async () => {
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(text('Priya'));
        await flowController.handleMessage(listItem('menu_book'));
        expect(stored.current_step).toBe('selecting_service');

        await flowController.handleMessage(listItem('service_blouse'));
        await flowController.handleMessage(button('add_more_items'));
        await flowController.handleMessage(listItem('service_lehenga'));
        expect(stored.cart.map((i: any) => i.service)).toEqual(['Designer Blouse', 'Lehenga Choli']);

        await flowController.handleMessage(button('proceed_checkout'));
        await flowController.handleMessage(button('appt_visit'));
        const day = upcomingOpenDays(7)[1]!;
        await flowController.handleMessage(listItem(day.id, day.title));
        await flowController.handleMessage(listItem('time_13', '01:00 PM - 03:00 PM'));
        expect(stored.current_step).toBe('confirming_booking');
        expect(lastCall(whatsappService.sendInteractiveButtons)[1]).toContain('Price will be shared after measurement');

        await flowController.handleMessage(button('confirm_booking'));

        const order = (Order.create as jest.Mock).mock.calls[0][0];
        expect(order).toMatchObject({
            customer_name: 'Priya',
            service: 'Designer Blouse, Lehenga Choli',
            appointment_type: 'visit',
            price: 0,
            booking_time: '01:00 PM - 03:00 PM',
            invoice_number: expect.stringMatching(/^RB-\d{8}-\d{4}$/)
        });
        expect(order.address).toBeUndefined();
        expect(Session.deleteOne).toHaveBeenCalled();
    });

    it('books a home pickup with location and address', async () => {
        leadName = 'Priya';
        await flowController.handleMessage(text('Hi'));
        await flowController.handleMessage(listItem('menu_book'));
        await flowController.handleMessage(listItem('service_salwar'));
        await flowController.handleMessage(button('proceed_checkout'));
        await flowController.handleMessage(button('appt_pickup'));
        const day = upcomingOpenDays(7)[1]!;
        await flowController.handleMessage(listItem(day.id, day.title));
        await flowController.handleMessage(listItem('time_17', '05:00 PM - 07:00 PM'));
        expect(stored.current_step).toBe('sharing_location');

        await flowController.handleMessage({ from: PHONE, type: 'location', location: { latitude: 22.79, longitude: 86.18 } });
        await flowController.handleMessage(text('Flat 4, Sakchi, Jamshedpur 831001'));
        await flowController.handleMessage(button('confirm_booking'));

        expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
            appointment_type: 'pickup',
            address: 'Flat 4, Sakchi, Jamshedpur 831001',
            latitude: 22.79
        }));
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
