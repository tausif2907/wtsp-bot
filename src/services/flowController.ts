import { Session } from '../models/Session';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { Lead } from '../models/Lead';
import { ChatMessage } from '../models/ChatMessage';
import { whatsappService } from './whatsapp';
import { STATUS_LABELS, shortOrderId } from './orderUpdates';
import { generateInvoiceHtml, generatePdfBuffer } from '../utils/pdfGenerator';
import { STORE, SERVICES, isOpenNow, upcomingOpenDays, slotsFor, storeContactLines, dayLabel } from '../config/store';
import {
    getProducts, getProduct, getRating, getAnnouncement, categoriesOf, collectionsOf, productsOn, shelfName, isShelfKey,
    inStockSizes, isAvailable, formatPrice, productUrl, Product, Rating
} from './catalog';
import crypto from 'crypto';

// Follow-up timers for abandoned bookings
const followUpTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

// Words that always bring the customer back to the welcome menu
const RESET_WORDS = ['hi', 'hello', 'hey', 'hii', 'namaste', 'start', 'menu', 'reset'];

// Only remind customers who stopped half-way through a booking
const BOOKING_STEPS = [
    'selecting_service', 'cart_review', 'choosing_appointment_type', 'selecting_date',
    'selecting_time', 'sharing_location', 'entering_address', 'confirming_booking'
];

// WhatsApp list limits
const MAX_LIST_ROWS = 10;
const ROW_TITLE_MAX = 24;
const ROW_DESC_MAX = 72;

// A design list holds 10 rows: up to 8 designs, "More Designs" and the way back to the categories
const PRODUCTS_PER_PAGE = 8;
// Photos sent after "More Photos" (the first one is already on the product card)
const MAX_EXTRA_PHOTOS = 4;

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function generateInvoiceNumber(): string {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randomPart = Math.floor(1000 + Math.random() * 9000);
    return `${STORE.invoicePrefix}-${datePart}-${randomPart}`;
}

// Stitching is priced after measurement, so items without a price show no amount
function formatCartSummary(cart: { service: string; price: number }[]): string {
    const lines = cart.map((item, i) => `${i + 1}. ${item.service}${item.price ? ` — ₹${item.price}` : ''}`);
    lines.push('');
    lines.push(priceLine(cart.reduce((s, item) => s + item.price, 0)));
    return lines.join('\n');
}

function priceLine(total: number): string {
    return total > 0 ? `*Total: ₹${total}*` : '_Price will be shared after measurement._';
}

function appointmentLine(session: any): string {
    return session.appointment_type === 'pickup'
        ? `Home pickup at: ${session.address}`
        : `Visit at: ${STORE.name}, ${STORE.address}`;
}

function formatBookingSlip(order: {
    invoice_number: string;
    order_id: string;
    customer_name: string;
    customer_phone: string;
    service: string;
    booking_date: string;
    booking_time: string;
    price: number;
    appointment_type: string;
    address?: string;
}): string {
    const line = '--------------------------------';
    return [
        `*${STORE.name.toUpperCase()}*`,
        `_${STORE.tagline}_`,
        line,
        '*BOOKING CONFIRMATION*',
        `Booking No: ${order.invoice_number}`,
        `Order ID: ${shortOrderId(order.order_id)}`,
        `Date: ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
        line,
        `*Customer*`,
        `Name: ${order.customer_name}`,
        `Phone: +${order.customer_phone}`,
        ...(order.appointment_type === 'pickup' ? [`Pickup address: ${order.address}`] : []),
        line,
        `*Appointment*`,
        order.appointment_type === 'pickup' ? 'Type: Home pickup' : 'Type: Measurement visit at the boutique',
        `When: ${order.booking_date}, ${order.booking_time}`,
        `Services: ${order.service}`,
        line,
        priceLine(order.price),
        line,
        '',
        `Thank you for choosing ${STORE.name} 🌸`,
        'For any queries, simply reply to this chat.'
    ].join('\n');
}

function productCaption(p: Product, rating?: Rating): string {
    const lines = [`*${p.name}*`];

    let price = formatPrice(p.price);
    if (p.mrp && p.mrp > p.price) {
        price += `  ~${formatPrice(p.mrp)}~  (${Math.round((1 - p.price / p.mrp) * 100)}% off)`;
    }
    lines.push(price);
    if (rating && rating.count > 0) lines.push(`⭐ ${rating.average.toFixed(1)} (${rating.count} review${rating.count === 1 ? '' : 's'})`);
    lines.push('');

    const details: [string, string][] = [
        ['Fabric', p.fabric], ['Colour', p.colour], ['Work', p.work], ['Occasion', p.occasion],
        ['Neckline', p.neckline], ['Sleeves', p.sleeves]
    ];
    for (const [label, value] of details) if (value) lines.push(`${label}: ${value}`);
    if (p.description) lines.push('', truncate(p.description, 300));
    if (p.model_info) lines.push(`_${p.model_info}_`);
    lines.push('');

    const sizes = inStockSizes(p);
    if (!isAvailable(p)) lines.push('❌ Currently sold out');
    else if (sizes.length > 0) lines.push(`✅ Sizes in stock: ${sizes.join(', ')}`);
    if (!p.is_sold_out && p.stitch_to_measure) lines.push(`✂️ Can be stitched to your measurements (+${formatPrice(p.stitch_price)}, made to order)`);
    const returns = returnPolicyLine(p);
    if (returns && isAvailable(p)) lines.push(returns);

    const url = productUrl(p);
    if (url) lines.push('', `🛍️ Order online: ${url}`);
    return truncate(lines.join('\n'), 1024);
}

// Same wording as RETURN_POLICIES in the website's src/lib/products.ts
function returnPolicyLine(p: Product): string {
    const days = STORE.returnWindowDays;
    if (p.return_policy === 'exchange_refund') return `↩️ Exchange or refund within ${days} days (ready sizes)`;
    if (p.return_policy === 'none') return '↩️ Not returnable';
    return `↩️ Easy exchange within ${days} days (ready sizes)`;
}

function productRowDescription(p: Product): string {
    let desc = formatPrice(p.price);
    if (p.mrp && p.mrp > p.price) desc += ` (${Math.round((1 - p.price / p.mrp) * 100)}% off)`;
    if (!isAvailable(p)) desc += ' · Sold out';
    else if (p.is_new_arrival) desc += ' · New arrival';
    else if (p.is_bestseller) desc += ' · Bestseller';
    if (p.fabric) desc += ` · ${p.fabric}`;
    return truncate(desc, ROW_DESC_MAX);
}

export class FlowController {

    async handleMessage(message: any) {
        const from = message.from;
        const msgType = message.type;

        // Find or create session
        let session = await Session.findOne({ phone_number: from });
        if (!session) {
            session = new Session({ phone_number: from, current_step: 'start', cart: [] });
            await session.save();
        }

        // Upsert lead — track every contact who messages
        await Lead.findOneAndUpdate(
            { phone_number: from },
            { $set: { last_active: new Date(), source: 'whatsapp' }, $setOnInsert: { name: '', type: 'unregistered', created_at: new Date() } },
            { upsert: true, new: true }
        );

        // Clear any existing follow-up timer for this user
        if (followUpTimers.has(from)) {
            clearTimeout(followUpTimers.get(from)!);
            followUpTimers.delete(from);
        }

        // If user sends a text greeting/reset word, always reset session
        if (msgType === 'text') {
            const textBody = message.text?.body?.toLowerCase().trim();
            if (RESET_WORDS.includes(textBody)) {
                session.current_step = 'start';
                session.cart = [];
            }
        }

        try {
            if (await this.handleEarlierMenuTap(from, session, message)) {
                // handled
            } else switch (session.current_step) {
                case 'start':
                    await this.handleStart(from, session);
                    break;
                case 'collecting_name':
                    await this.handleInitialNameEntry(from, session, message);
                    break;
                case 'main_menu':
                    await this.handleMainMenu(from, session, message);
                    break;
                case 'talking_to_staff':
                    // Our team is replying personally from the dashboard inbox — the bot stays quiet until "Hi"
                    await this.saveForInbox(from, session, message);
                    break;
                case 'browsing_categories':
                    await this.handleCategorySelection(from, session, message);
                    break;
                case 'browsing_products':
                    await this.handleProductSelection(from, session, message);
                    break;
                case 'viewing_product':
                    await this.handleProductAction(from, session, message);
                    break;
                case 'selecting_service':
                    await this.handleServiceSelection(from, session, message);
                    break;
                case 'cart_review':
                    await this.handleCartReview(from, session, message);
                    break;
                case 'choosing_appointment_type':
                    await this.handleAppointmentType(from, session, message);
                    break;
                case 'selecting_date':
                    await this.handleDateSelection(from, session, message);
                    break;
                case 'selecting_time':
                    await this.handleTimeSelection(from, session, message);
                    break;
                case 'sharing_location':
                    await this.handleLocationEntry(from, session, message);
                    break;
                case 'entering_address':
                    await this.handleAddressEntry(from, session, message);
                    break;
                case 'confirming_booking':
                    await this.handleConfirmation(from, session, message);
                    break;
                default:
                    await whatsappService.sendText(from, 'Sorry, something went wrong on our side. Please type "Hi" to start again.');
                    session.current_step = 'start';
                    session.cart = [];
                    await session.save();
            }
        } catch (error) {
            console.error('Error in flow controller:', error);
            await whatsappService.sendText(from, 'We apologise for the inconvenience. Please type "Hi" to restart.');
            session.current_step = 'start';
            session.cart = [];
            await session.save();
        }

        // Schedule 5-minute follow-up for abandoned bookings
        this.scheduleFollowUp(from, session.current_step);
    }

    // Customers often scroll up and tap an older menu, category or product list.
    // Those choices name what they want, so honour them from any step.
    private async handleEarlierMenuTap(from: string, session: any, message: any): Promise<boolean> {
        if (['start', 'collecting_name'].includes(session.current_step)) return false;
        const id = this.menuChoice(message) || '';

        if (id.startsWith('menu_')) {
            await this.handleMainMenu(from, session, message);
        } else if (isShelfKey(id)) {
            await this.handleCategorySelection(from, session, message);
        } else if (id.startsWith('prod:') || id.startsWith('more:') || id === 'back_categories') {
            await this.handleProductSelection(from, session, message);
        } else if (id.startsWith('prod_') && session.product_id && session.current_step !== 'viewing_product') {
            await this.handleProductAction(from, session, message);
        } else {
            return false;
        }
        return true;
    }

    private scheduleFollowUp(phone: string, currentStep: string) {
        if (!BOOKING_STEPS.includes(currentStep)) return;

        const timer = setTimeout(async () => {
            try {
                followUpTimers.delete(phone);
                const session = await Session.findOne({ phone_number: phone });
                if (session && BOOKING_STEPS.includes(session.current_step)) {
                    let followUpMsg = `Your ${STORE.name} booking is still waiting for you 🌸\n\nSimply reply to continue where you left off, or type "Hi" to start fresh.`;
                    if (session.cart && session.cart.length > 0) {
                        const cartItems = session.cart.map((item: any) => item.service).join(', ');
                        followUpMsg = `You were booking *${cartItems}* with ${STORE.name} 🌸\n\nWould you like to finish your booking? Simply reply to continue, or type "Hi" to start fresh.`;
                    }
                    await whatsappService.sendText(phone, followUpMsg);
                }
            } catch (err) {
                console.error('Follow-up error:', err);
            }
        }, 5 * 60 * 1000); // 5 minutes

        followUpTimers.set(phone, timer);
    }

    private async handleStart(from: string, session: any) {
        session.cart = [];

        // Check if we already have the lead's name
        const lead = await Lead.findOne({ phone_number: from });
        if (lead && lead.name) {
            session.name = lead.name;
            await this.showMainMenu(from, session, true);
        } else {
            // Ask for name first
            session.current_step = 'collecting_name';
            await session.save();
            await whatsappService.sendText(
                from,
                `🌸 *Namaste! Welcome to ${STORE.name}* 🌸\n_${STORE.tagline}_\n\nDesigner blouses, lehengas and salwar suits — stitched to your perfect fit.\n\nMay we know your name?`
            );
        }
    }

    private async handleInitialNameEntry(from: string, session: any, message: any) {
        if (message.type !== 'text') {
            await whatsappService.sendText(from, 'Please type your name to continue.');
            return;
        }

        const customerName = message.text.body.trim();
        session.name = customerName;

        // Update the Lead record immediately
        await Lead.findOneAndUpdate(
            { phone_number: from },
            { $set: { name: customerName, type: 'unregistered' } }, // Remains unregistered until order confirmed
            { upsert: true }
        );

        await this.showMainMenu(from, session, false);
    }

    private async showMainMenu(from: string, session: any, returning: boolean) {
        session.current_step = 'main_menu';
        await session.save();

        const greeting = returning
            ? `🌸 *Welcome back to ${STORE.name}, ${session.name}!*`
            : `Lovely to meet you, *${session.name}* 🌸`;

        // The website's offer strip, when the owner has one running
        const offer = await getAnnouncement();
        const offerNote = offer ? `\n\n🎉 *${offer.text}*` : '';

        await whatsappService.sendInteractiveList(
            from,
            `${greeting}${offerNote}\n\nHow can we help you today?`,
            {
                buttonText: 'Choose an Option',
                title: STORE.name,
                rows: [
                    { id: 'menu_shop', title: 'Shop Our Collection', description: 'Ready designs from our online store' },
                    { id: 'menu_book', title: 'Book Stitching', description: 'Book a measurement visit or home pickup' },
                    { id: 'menu_orders', title: 'My Bookings', description: 'Check the status and price of your orders' },
                    { id: 'menu_visit', title: 'Visit the Boutique', description: 'Address, directions and opening hours' },
                    { id: 'menu_talk', title: 'Talk to Us', description: 'Chat with our boutique team' }
                ]
            }
        );
    }

    // Main menu choices arrive as list replies; the follow-up buttons after "Visit" as button replies
    private menuChoice(message: any): string | null {
        if (message.type !== 'interactive') return null;
        if (message.interactive.type === 'list_reply') return message.interactive.list_reply.id;
        if (message.interactive.type === 'button_reply') return message.interactive.button_reply.id;
        return null;
    }

    private async handleMainMenu(from: string, session: any, message: any) {
        const choice = this.menuChoice(message);

        switch (choice) {
            case 'menu_shop':
                await this.showCategories(from, session);
                return;
            case 'menu_book':
                session.cart = [];
                await this.showServiceMenu(from, session);
                return;
            case 'menu_orders':
                await this.showMyBookings(from, session);
                return;
            case 'menu_visit':
                await this.sendVisitInfo(from);
                return;
            case 'menu_talk':
                await this.handOffToStaff(from, session);
                return;
            default:
                await this.showMainMenu(from, session, true);
        }
    }

    private async sendVisitInfo(from: string) {
        const visitMsg = [
            `🏬 *Visit ${STORE.name}*`,
            '',
            ...storeContactLines(),
            '',
            '🕘 *Opening Hours*',
            STORE.hoursText,
            '',
            isOpenNow() ? '🟢 We are open right now.' : '🔴 We are closed right now.',
            '',
            'Bring your fabric, a design photo you love, or a well-fitting sample garment.'
        ].join('\n');
        await whatsappService.sendText(from, visitMsg);
        await whatsappService.sendInteractiveButtons(from, 'What would you like to do next?', [
            { id: 'menu_book', title: 'Book Stitching' },
            { id: 'menu_shop', title: 'Shop Collection' },
            { id: 'menu_talk', title: 'Talk to Us' }
        ]);
    }

    private async showMyBookings(from: string, session: any) {
        session.current_step = 'main_menu';
        await session.save();

        const orders = await Order.find({ customer_phone: from }).sort({ created_at: -1 }).limit(5);
        if (orders.length === 0) {
            await whatsappService.sendInteractiveButtons(from, `You have no bookings with us yet 🌸\n\nWould you like to book a stitching appointment?`, [
                { id: 'menu_book', title: 'Book Stitching' },
                { id: 'menu_shop', title: 'Shop Collection' }
            ]);
            return;
        }

        const bookings = orders.map(o => [
            `*${shortOrderId(o.order_id)}* · ${STATUS_LABELS[o.status] || o.status}`,
            o.service,
            `${o.appointment_type === 'pickup' ? 'Pickup' : 'Visit'}: ${o.booking_date}, ${o.booking_time}`,
            o.price > 0 ? `Price: ${formatPrice(o.price)}` : 'Price: shared after measurement'
        ].join('\n'));
        await whatsappService.sendText(from, `🧾 *Your ${STORE.name} bookings*\n\n${bookings.join('\n\n')}`);
        await whatsappService.sendInteractiveButtons(from, 'Anything else we can help you with?', [
            { id: 'menu_talk', title: 'Talk to Us' },
            { id: 'menu_book', title: 'Book Stitching' },
            { id: 'menu_home', title: 'Main Menu' }
        ]);
    }

    private async handOffToStaff(from: string, session: any, product?: Product) {
        session.current_step = 'talking_to_staff';
        session.handoff_at = new Date();
        session.handoff_topic = product ? product.name : '';
        await session.save();

        const about = product ? ` about *${product.name}*` : '';
        await whatsappService.sendText(
            from,
            `Thank you, ${session.name || 'dear'}! 🌸\n\nOur boutique team will reply to you${about} personally here${isOpenNow() ? ' shortly' : ' as soon as we open'}.\n\n🕘 ${STORE.hoursText.replace('\n', ' | ')}\n\nYou can send your questions, design photos or measurements in the meantime.\n\nType "Hi" anytime to return to the menu.`
        );

        const ownerPhone = process.env.OWNER_PHONE_NUMBER;
        if (ownerPhone && ownerPhone !== 'owner_number_with_country_code') {
            const productLines = product ? ['', `Asking about: ${product.name} (${formatPrice(product.price)})`, productUrl(product)].filter(Boolean) : [];
            await whatsappService.sendText(
                ownerPhone,
                [`*CUSTOMER WANTS TO TALK*`, '', `Name: ${session.name || 'Unknown'}`, `Phone: +${from}`, ...productLines, '', 'Their messages are in the dashboard inbox. Please reply from there.'].join('\n')
            );
        }
    }

    // Keep what the customer sends while our team is chatting, for the dashboard inbox
    private async saveForInbox(from: string, session: any, message: any) {
        const media = ['image', 'document', 'audio', 'video', 'sticker'].includes(message.type) ? message[message.type] : null;
        const text = message.type === 'location'
            ? `📍 Shared a location: https://www.google.com/maps?q=${message.location.latitude},${message.location.longitude}`
            : message.text?.body ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? media?.caption ?? '';

        await ChatMessage.create({
            phone_number: from,
            direction: 'in',
            text,
            ...(media?.id ? { media_id: media.id, media_type: message.type } : {})
        });
        await session.save(); // keeps the chat open; sessions expire a day after the last message
    }

    // ---------------------------------------------------------------- shop collection (from the website)
    // Products come live from the website's database (see services/catalog.ts), so anything added,
    // edited, sold out or removed in the website admin shows up here within 30 seconds.

    private async showCategories(from: string, session: any) {
        const products = await getProducts();
        const categories = categoriesOf(products);

        if (categories.length === 0) {
            await whatsappService.sendText(
                from,
                `Our online collection is being updated right now 🌸\n\nPlease visit the boutique to see our latest designs, or choose *Talk to Us* and we'll share photos with you.`
            );
            await this.showMainMenu(from, session, true);
            return;
        }

        session.current_step = 'browsing_categories';
        await session.save();

        // New arrivals and offers first, then the website's categories
        const rows = [...collectionsOf(products), ...categories].slice(0, MAX_LIST_ROWS).map(c => ({
            id: c.key,
            title: truncate(c.name, ROW_TITLE_MAX),
            description: `${c.count} design${c.count === 1 ? '' : 's'}`
        }));

        await whatsappService.sendInteractiveList(
            from,
            `🛍️ *${STORE.name} Collection*\n\n${products.length} design${products.length === 1 ? '' : 's'} available. Which would you like to see?`,
            { buttonText: 'View Categories', title: 'Categories', rows }
        );
    }

    private async handleCategorySelection(from: string, session: any, message: any) {
        const id = this.menuChoice(message) || '';
        if (!isShelfKey(id)) {
            await this.showCategories(from, session);
            return;
        }

        session.browse_category = id;
        await this.showProducts(from, session, 0);
    }

    private async showProducts(from: string, session: any, page: number) {
        // Older sessions saved the plain category name
        const raw = session.browse_category || '';
        const key = isShelfKey(raw) ? raw : `cat:${raw}`;
        const products = productsOn(await getProducts(), key);
        if (products.length === 0) {
            await whatsappService.sendText(from, 'Those designs are no longer in our collection. Here is what we have now 🌸');
            await this.showCategories(from, session);
            return;
        }

        const pages = Math.ceil(products.length / PRODUCTS_PER_PAGE);
        const current = Math.min(Math.max(page, 0), pages - 1);
        const start = current * PRODUCTS_PER_PAGE;
        const shown = products.slice(start, start + PRODUCTS_PER_PAGE);

        const rows = shown.map(p => ({ id: `prod:${p.id}`, title: truncate(p.name, ROW_TITLE_MAX), description: productRowDescription(p) }));
        if (current < pages - 1) {
            const nextEnd = Math.min(start + 2 * PRODUCTS_PER_PAGE, products.length);
            rows.push({ id: `more:${current + 1}:${key}`, title: 'More Designs »', description: `Designs ${start + PRODUCTS_PER_PAGE + 1}–${nextEnd} of ${products.length}` });
        }
        rows.push({ id: 'back_categories', title: '« All Categories', description: 'Browse another category' });

        session.browse_category = key;
        session.browse_page = current;
        session.current_step = 'browsing_products';
        await session.save();

        const name = shelfName(key);
        const range = pages > 1 ? `\n\nShowing ${start + 1}–${start + shown.length} of ${products.length}, newest first.` : '';
        await whatsappService.sendInteractiveList(
            from,
            `*${name}*\n\nTap a design to see photos, sizes and price.${range}`,
            { buttonText: 'View Designs', title: truncate(name, ROW_TITLE_MAX), rows }
        );
    }

    private async handleProductSelection(from: string, session: any, message: any) {
        const id = this.menuChoice(message) || '';

        if (id === 'back_categories') {
            await this.showCategories(from, session);
            return;
        }

        // "more:<page>:<shelf>" — the shelf is in the id, so a tap on an older list still opens the right one
        if (id.startsWith('more:')) {
            const [, page, ...shelf] = id.split(':');
            session.browse_category = shelf.join(':');
            await this.showProducts(from, session, Number(page) || 0);
            return;
        }

        const product = id.startsWith('prod:') ? await getProduct(id.slice(5)) : undefined;
        if (!product) {
            if (id.startsWith('prod:')) {
                await whatsappService.sendText(from, 'Sorry, that design is no longer in our collection. Here are the designs we have now 🌸');
            }
            await this.showProducts(from, session, session.browse_page || 0);
            return;
        }

        await this.showProduct(from, session, product);
    }

    private async showProduct(from: string, session: any, product: Product) {
        session.product_id = product.id;
        session.current_step = 'viewing_product';
        await session.save();

        const caption = productCaption(product, await getRating(product.id));
        const photo = product.images[0];
        if (photo) {
            await whatsappService.sendImageLink(from, photo, caption);
        } else {
            await whatsappService.sendText(from, caption);
        }

        const extraPhotos = product.images.length - 1;
        await whatsappService.sendInteractiveButtons(from, 'Would you like to know more about this design?', [
            { id: 'prod_ask', title: 'Ask About This' },
            extraPhotos > 0 ? { id: 'prod_photos', title: `More Photos (${extraPhotos})` } : { id: 'prod_menu', title: 'Main Menu' },
            { id: 'prod_more', title: 'More Designs' }
        ]);
    }

    private async handleProductAction(from: string, session: any, message: any) {
        const id = this.menuChoice(message) || '';

        if (id === 'prod_ask') {
            await this.handOffToStaff(from, session, await getProduct(session.product_id));
        } else if (id === 'prod_photos') {
            await this.sendMorePhotos(from, session);
        } else if (id === 'prod_more') {
            await this.showProducts(from, session, session.browse_page || 0);
        } else {
            await this.showMainMenu(from, session, true);
        }
    }

    private async sendMorePhotos(from: string, session: any) {
        const product = await getProduct(session.product_id);
        if (!product) {
            await whatsappService.sendText(from, 'Sorry, that design is no longer in our collection.');
            await this.showCategories(from, session);
            return;
        }

        const total = product.images.length;
        const extra = product.images.slice(1, 1 + MAX_EXTRA_PHOTOS);
        for (const [i, link] of extra.entries()) {
            await whatsappService.sendImageLink(from, link, `${product.name} (${i + 2}/${total})`);
        }

        const url = productUrl(product);
        const allPhotos = total > extra.length + 1 && url ? `\n\nSee all ${total} photos at ${url}` : '';
        session.current_step = 'viewing_product';
        await session.save();
        await whatsappService.sendInteractiveButtons(from, `Like this design?${allPhotos}`, [
            { id: 'prod_ask', title: 'Ask About This' },
            { id: 'prod_more', title: 'More Designs' },
            { id: 'prod_menu', title: 'Main Menu' }
        ]);
    }

    // ---------------------------------------------------------------- stitching booking

    private async showServiceMenu(from: string, session: any) {
        const cartCount = session.cart.length;
        const cartNote = cartCount > 0
            ? `\n\n🧵 *You have chosen ${cartCount} service(s).* Pick another to add it.`
            : '';

        await whatsappService.sendInteractiveList(
            from,
            `✂️ *${STORE.name} — Stitching Services*\n\nEvery outfit is cut and stitched to your measurements by our master tailors. Bring a design photo, sketch or saree you love.\n\nPlease choose a service:${cartNote}`,
            {
                buttonText: 'View Services',
                title: 'Our Services',
                rows: SERVICES.map(s => ({ id: s.id, title: s.title, description: s.description }))
            }
        );
        session.current_step = 'selecting_service';
        await session.save();
    }

    private async handleServiceSelection(from: string, session: any, message: any) {
        if (message.type !== 'interactive' || message.interactive.type !== 'list_reply') {
            await whatsappService.sendText(from, 'Kindly select a service from the menu above.');
            return;
        }

        const service = SERVICES.find(s => s.id === message.interactive.list_reply.id);
        if (!service) {
            await whatsappService.sendText(from, 'Invalid selection. Please choose from the menu above.');
            return;
        }

        session.cart.push({ service: service.title, price: service.price || 0 });
        await session.save();

        await this.showCartReview(from, session);
    }

    private async showCartReview(from: string, session: any) {
        session.current_step = 'cart_review';
        await session.save();

        const msg = `*🧵 Your Booking*\n\n${formatCartSummary(session.cart)}\n\nWould you like to add another outfit or choose your appointment?`;

        await whatsappService.sendInteractiveButtons(from, msg, [
            { id: 'add_more_items', title: 'Add Another' },
            { id: 'proceed_checkout', title: 'Book Appointment' }
        ]);
    }

    private async handleCartReview(from: string, session: any, message: any) {
        if (message.type !== 'interactive' || message.interactive.type !== 'button_reply') {
            await whatsappService.sendText(from, 'Please use the buttons to add another outfit or book your appointment.');
            return;
        }

        const buttonId = message.interactive.button_reply.id;

        if (buttonId === 'add_more_items') {
            await this.showServiceMenu(from, session);
            return;
        }

        if (buttonId === 'proceed_checkout') {
            session.current_step = 'choosing_appointment_type';
            await session.save();

            await whatsappService.sendInteractiveButtons(
                from,
                `📏 *How would you like to give your measurements?*\n\n• *Visit the Boutique* — a careful fitting session at our Bistupur shop.\n• *Home Pickup* — our team collects your fabric and sample from your home.`,
                [
                    { id: 'appt_visit', title: 'Visit the Boutique' },
                    { id: 'appt_pickup', title: 'Home Pickup' }
                ]
            );
        }
    }

    private async handleAppointmentType(from: string, session: any, message: any) {
        const id = message.type === 'interactive' && message.interactive.type === 'button_reply' ? message.interactive.button_reply.id : '';
        if (id !== 'appt_visit' && id !== 'appt_pickup') {
            await whatsappService.sendText(from, 'Please choose *Visit the Boutique* or *Home Pickup* using the buttons above.');
            return;
        }

        session.appointment_type = id === 'appt_pickup' ? 'pickup' : 'visit';
        session.current_step = 'selecting_date';
        await session.save();
        await this.sendDateList(from);
    }

    private async sendDateList(from: string) {
        await whatsappService.sendInteractiveList(
            from,
            `📅 Which day suits you?\n\n_We are closed on Tuesdays._`,
            {
                buttonText: 'Select Date',
                title: 'Available Days',
                rows: upcomingOpenDays(7)
            }
        );
    }

    private async handleDateSelection(from: string, session: any, message: any) {
        if (message.type !== 'interactive' || message.interactive.type !== 'list_reply') {
            await whatsappService.sendText(from, 'Kindly select a date from the menu above.');
            return;
        }

        // A date tapped in a list sent days ago may have passed
        const dateId = message.interactive.list_reply.id;
        if (!upcomingOpenDays(7).some(d => d.id === dateId)) {
            await whatsappService.sendText(from, 'Sorry, that day is no longer available. Please choose another day.');
            await this.sendDateList(from);
            return;
        }

        session.selected_day = dateId.slice('date_'.length);
        session.selected_date = dayLabel(session.selected_day);
        session.current_step = 'selecting_time';
        await session.save();

        await whatsappService.sendInteractiveList(
            from,
            `Date selected: *${session.selected_date}*\n\n🕐 Please choose a convenient time:`,
            {
                buttonText: 'Select Time',
                title: 'Time Slots',
                rows: slotsFor(dateId).map(slot => ({ id: `time_${slot.start}`, title: slot.label }))
            }
        );
    }

    private async handleTimeSelection(from: string, session: any, message: any) {
        if (message.type !== 'interactive' || message.interactive.type !== 'list_reply') {
            await whatsappService.sendText(from, 'Kindly select a time slot from the menu above.');
            return;
        }

        session.selected_time = message.interactive.list_reply.title;

        if (session.appointment_type === 'pickup') {
            session.current_step = 'sharing_location';
            await session.save();
            await whatsappService.sendText(
                from,
                '📍 Please share your location so our team can find you for pickup.\n\nTap the 📎 attachment icon and select *Location*.'
            );
            return;
        }

        await this.showBookingSummary(from, session);
    }

    private async handleLocationEntry(from: string, session: any, message: any) {
        if (message.type !== 'location') {
            await whatsappService.sendText(from, 'Please share your location using the 📎 attachment icon > Location.');
            return;
        }

        session.location_lat = message.location.latitude;
        session.location_lng = message.location.longitude;
        session.current_step = 'entering_address';
        await session.save();

        await whatsappService.sendText(
            from,
            'Location received ✅\n\nPlease type your complete address (house/flat number, building, street, landmark, city, pincode):'
        );
    }

    private async handleAddressEntry(from: string, session: any, message: any) {
        if (message.type !== 'text') {
            await whatsappService.sendText(from, 'Please type your address as a text message.');
            return;
        }

        session.address = message.text.body.trim();
        await this.showBookingSummary(from, session);
    }

    private async showBookingSummary(from: string, session: any) {
        session.current_step = 'confirming_booking';
        await session.save();

        const summaryText = [
            `*${STORE.name} — Booking Summary*`,
            '',
            `Name: ${session.name}`,
            `Date: ${session.selected_date}`,
            `Time: ${session.selected_time}`,
            appointmentLine(session),
            '',
            '*Services:*',
            formatCartSummary(session.cart),
            '',
            'Please confirm your booking, or choose Edit to make changes.'
        ].join('\n');

        await whatsappService.sendInteractiveButtons(from, summaryText, [
            { id: 'confirm_booking', title: 'Confirm Booking' },
            { id: 'edit_booking', title: 'Edit Details' }
        ]);
    }

    private async handleConfirmation(from: string, session: any, message: any) {
        if (message.type !== 'interactive' || message.interactive.type !== 'button_reply') {
            await whatsappService.sendText(from, 'Please use the Confirm or Edit buttons to proceed.');
            return;
        }

        const buttonId = message.interactive.button_reply.id;

        if (buttonId === 'edit_booking') {
            session.cart = [];
            await this.showServiceMenu(from, session);
            return;
        }

        if (buttonId === 'confirm_booking') {
            const orderId = crypto.randomUUID();
            const invoiceNumber = generateInvoiceNumber();
            const totalPrice = session.cart.reduce((s: number, item: any) => s + item.price, 0);
            const serviceNames = session.cart.map((item: any) => item.service).join(', ');
            const isPickup = session.appointment_type === 'pickup';
            const mapUrl = isPickup ? `https://www.google.com/maps?q=${session.location_lat},${session.location_lng}` : STORE.mapsLink;

            // 1. Upsert Customer
            await Customer.findOneAndUpdate(
                { phone_number: from },
                isPickup
                    ? { name: session.name, location_lat: session.location_lat, location_lng: session.location_lng, address: session.address }
                    : { name: session.name },
                { upsert: true, new: true }
            );

            // 2. Create Order
            const orderData = {
                order_id: orderId,
                customer_phone: from,
                customer_name: session.name,
                service: serviceNames,
                booking_date: session.selected_date,
                booking_time: session.selected_time,
                appointment_day: session.selected_day,
                appointment_type: isPickup ? 'pickup' : 'visit',
                ...(isPickup ? { latitude: session.location_lat, longitude: session.location_lng, address: session.address } : {}),
                price: totalPrice,
                invoice_number: invoiceNumber,
                status: 'order_received'
            };
            await Order.create(orderData);

            // 3. Send booking slip to customer
            await whatsappService.sendText(from, formatBookingSlip(orderData));

            // 4. Send Confirmation Text
            const nextStep = isPickup
                ? `Our team will come to your address on *${session.selected_date}, ${session.selected_time}* to collect your fabric.`
                : `We look forward to seeing you at the boutique on *${session.selected_date}, ${session.selected_time}*.\n\n📍 ${STORE.address}${STORE.mapsLink ? `\n🗺️ ${STORE.mapsLink}` : ''}`;
            await whatsappService.sendText(
                from,
                `🎉 Your booking is confirmed, ${session.name}!\n\nOrder ID: *${shortOrderId(orderId)}*\nBooking No: *${invoiceNumber}*\n\n${nextStep}\n\nYou will receive status updates on this chat. Thank you for choosing ${STORE.name} 🌸`
            );

            // 5. Send PDF booking slip
            try {
                const html = await generateInvoiceHtml(orderData, STATUS_LABELS.order_received || 'Booked', mapUrl);
                const pdfBuffer = await generatePdfBuffer(html);
                const fileName = `${STORE.name.replace(/\s+/g, '_')}_${invoiceNumber}.pdf`;
                const mediaId = await whatsappService.uploadMedia(pdfBuffer, 'application/pdf', fileName);
                if (mediaId) {
                    await whatsappService.sendDocument(from, mediaId, fileName, `Your ${STORE.name} booking slip.`);
                }
            } catch (pdfError) {
                console.error('Failed to generate/send PDF:', pdfError);
            }

            // 6. Notify Owner
            const ownerPhone = process.env.OWNER_PHONE_NUMBER;
            if (ownerPhone && ownerPhone !== 'owner_number_with_country_code') {
                const ownerMsg = [
                    `*NEW ${STORE.name.toUpperCase()} BOOKING*`,
                    '',
                    `Order ID: ${shortOrderId(orderId)}`,
                    `Booking No: ${invoiceNumber}`,
                    '',
                    '*Customer Details*',
                    `Name: ${session.name}`,
                    `Phone: +${from}`,
                    ...(isPickup ? [`Address: ${session.address}`, `Location: ${mapUrl}`] : []),
                    '',
                    '*Booking Details*',
                    `Type: ${isPickup ? 'Home pickup' : 'Visit to boutique'}`,
                    `Services: ${serviceNames}`,
                    `Date: ${session.selected_date}`,
                    `Time: ${session.selected_time}`,
                    totalPrice > 0 ? `Amount: ₹${totalPrice}` : 'Amount: to quote after measurement',
                ].join('\n');
                await whatsappService.sendText(ownerPhone, ownerMsg);
            }

            // 7. Update Lead to registered
            await Lead.findOneAndUpdate(
                { phone_number: from },
                { type: 'registered', name: session.name }
            );

            // 8. Reset Session
            if (followUpTimers.has(from)) {
                clearTimeout(followUpTimers.get(from)!);
                followUpTimers.delete(from);
            }
            await Session.deleteOne({ phone_number: from });
        }
    }
}

export const flowController = new FlowController();
