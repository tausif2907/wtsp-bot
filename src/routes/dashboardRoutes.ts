import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { Lead } from '../models/Lead';
import { Session } from '../models/Session';
import { ChatMessage } from '../models/ChatMessage';
import { whatsappService } from '../services/whatsapp';
import { ORDER_STATUSES, STATUS_LABELS, shortOrderId, statusUpdateMessage, priceQuoteMessage } from '../services/orderUpdates';
import { getProducts, getRating, syncCatalog, getCatalogStatus } from '../services/catalog';
import { STORE, storeContactLines } from '../config/store';
import { generateInvoiceHtml } from '../utils/pdfGenerator';
import { escapeHtml as esc } from '../utils/html';
import { requireStaff, requireAdmin } from '../middleware/auth';

const router = Router();

// Every dashboard API needs a login. Delivery staff can see orders and update their status;
// everything else is for boutique admins.
router.use(requireStaff);

const PHONE_PATTERN = /^\d{6,15}$/;

// Route params are typed loosely once a route has extra middleware
const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || '';

// Get all customers
router.get('/customers', requireAdmin, async (req, res) => {
    try {
        const customers = await Customer.find().sort({ created_at: -1 });
        res.json(customers);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// Get all orders
router.get('/orders', async (req, res) => {
    try {
        const orders = await Order.find().sort({ created_at: -1 });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Update order status + send WhatsApp notification
router.patch('/orders/:orderId/status', async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body;

        if (!ORDER_STATUSES.some(s => s.value === status)) {
            res.status(400).json({ error: 'Invalid status' });
            return;
        }

        const order = await Order.findOneAndUpdate(
            { order_id: orderId },
            { status },
            { new: true }
        );

        if (!order) {
            res.status(404).json({ error: 'Order not found' });
            return;
        }

        const notified = await whatsappService.sendText(order.customer_phone, statusUpdateMessage(order));
        res.json({ success: true, notified, order });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Set the price after measurement and keep the team's notes
router.patch('/orders/:orderId', requireAdmin, async (req, res) => {
    try {
        const order = await Order.findOne({ order_id: param(req.params.orderId) });
        if (!order) {
            res.status(404).json({ error: 'Order not found' });
            return;
        }

        const { price, notes, notify } = req.body;
        const priceChanged = price !== undefined && Number(price) !== order.price;

        if (price !== undefined) {
            const amount = Number(price);
            if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) {
                res.status(400).json({ error: 'Please enter a valid price.' });
                return;
            }
            order.price = Math.round(amount);
        }
        if (notes !== undefined) {
            order.notes = String(notes).slice(0, 5000);
        }
        await order.save();

        let notified = false;
        if (notify && priceChanged && order.price > 0) {
            notified = await whatsappService.sendText(order.customer_phone, priceQuoteMessage(order));
        }

        res.json({ success: true, notified, order });
    } catch (error) {
        console.error('Error updating order:', error);
        res.status(500).json({ error: 'Failed to update order' });
    }
});

// Analytics — service popularity
router.get('/analytics', requireAdmin, async (req, res) => {
    try {
        const orders = await Order.find();
        const serviceCounts: Record<string, number> = {};
        const statusCounts: Record<string, number> = {};
        const appointmentCounts: Record<string, number> = { visit: 0, pickup: 0 };
        let totalRevenue = 0;
        let awaitingPrice = 0;

        orders.forEach(order => {
            if (order.service) {
                const services = order.service.split(',').map((s: string) => {
                    // Remove anything in parentheses (e.g., "Express Stitching (24 Hours)" -> "Express Stitching")
                    return s.replace(/\s*\(.*?\)\s*/g, '').trim();
                });
                services.forEach((s: string) => {
                    serviceCounts[s] = (serviceCounts[s] || 0) + 1;
                });
            }
            statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;
            appointmentCounts[order.appointment_type === 'visit' ? 'visit' : 'pickup']! += 1;

            if (order.status === 'cancelled') return;
            totalRevenue += order.price || 0;
            if (!order.price && order.status !== 'delivered') awaitingPrice++;
        });

        res.json({
            serviceCounts,
            statusCounts,
            appointmentCounts,
            totalRevenue,
            awaitingPrice,
            totalOrders: orders.length
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Invoice HTML for printing
router.get('/orders/:orderId/invoice', async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ order_id: orderId });

        if (!order) {
            res.status(404).json({ error: 'Order not found' });
            return;
        }

        const mapUrl = order.latitude && order.longitude ? `https://www.google.com/maps?q=${order.latitude},${order.longitude}` : STORE.mapsLink;
        const statusLabel = STATUS_LABELS[order.status] || order.status;

        let html = await generateInvoiceHtml(order.toObject(), statusLabel, mapUrl);
        // Add the print button for the dashboard view
        html += `
<div class="no-print" style="text-align:center; margin-top:20px; padding-bottom: 40px;">
    <button onclick="window.print()" style="padding:10px 30px; background:${STORE.colors.primary}; color:white; border:none; border-radius:8px; cursor:pointer; font-size:14px; font-weight:600; text-transform:uppercase; letter-spacing:1px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">Print Invoice</button>
</div>
</body></html>`;

        // Strip the existing </body></html> from the generator output, since we want to inject the button before it
        html = html.replace('</body></html>', '');

        res.send(html);
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate invoice' });
    }
});

// Receipt HTML for shop (thermal-style white receipt)
router.get('/orders/:orderId/receipt', async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await Order.findOne({ order_id: orderId });

        if (!order) {
            res.status(404).json({ error: 'Order not found' });
            return;
        }

        const shortId = shortOrderId(order.order_id);
        const orderDate = new Date(order.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

        // Parse services if comma-separated (cart items)
        const services = order.service.split(',').map((s: string) => s.trim());

        const receiptHtml = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Receipt - ${shortId}</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Courier New', Courier, monospace; padding: 20px; background: #f5f5f5; }
    .receipt {
        width: 300px; margin: 0 auto; background: #fff; padding: 25px 20px;
        border: 1px dashed #ccc; position: relative;
    }
    .receipt::before, .receipt::after {
        content: ''; position: absolute; left: 0; right: 0; height: 10px;
        background: repeating-linear-gradient(90deg, transparent, transparent 4px, #f5f5f5 4px, #f5f5f5 8px);
    }
    .receipt::before { top: -10px; }
    .receipt::after { bottom: -10px; }
    .shop-name { text-align: center; font-size: 18px; font-weight: bold; letter-spacing: 2px; margin-bottom: 2px; }
    .shop-sub { text-align: center; font-size: 10px; color: #666; margin-bottom: 12px; }
    .divider { border: none; border-top: 1px dashed #aaa; margin: 10px 0; }
    .row { display: flex; justify-content: space-between; font-size: 12px; line-height: 1.8; }
    .row .label { color: #555; }
    .row .value { font-weight: bold; text-align: right; max-width: 160px; word-break: break-word; }
    .section-title { font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin: 8px 0 4px; color: #333; }
    .items { margin: 4px 0; }
    .item-row { display: flex; justify-content: space-between; font-size: 12px; line-height: 1.6; }
    .total-row { display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; margin-top: 6px; padding-top: 6px; border-top: 1px solid #333; }
    .footer { text-align: center; font-size: 10px; color: #888; margin-top: 12px; line-height: 1.6; }
    .barcode { text-align: center; font-size: 28px; letter-spacing: 4px; margin: 8px 0; font-family: 'Libre Barcode 39', cursive; }
    .order-tag { text-align: center; font-size: 20px; font-weight: bold; letter-spacing: 3px; margin: 6px 0; padding: 6px; border: 2px solid #333; }
    @media print {
        body { padding: 0; background: #fff; }
        .receipt { border: none; box-shadow: none; }
        .no-print { display: none !important; }
    }
</style>
</head><body>
<div class="receipt">
    <div class="shop-name">${STORE.name.toUpperCase()}</div>
    <div class="shop-sub">${STORE.tagline}</div>

    <div class="order-tag">${shortId}</div>

    <hr class="divider">

    <div class="row"><span class="label">Date:</span><span class="value">${orderDate}</span></div>
    <div class="row"><span class="label">Invoice:</span><span class="value">${esc(order.invoice_number || 'N/A')}</span></div>

    <hr class="divider">
    <div class="section-title">Customer</div>
    <div class="row"><span class="label">Name:</span><span class="value">${esc(order.customer_name)}</span></div>
    <div class="row"><span class="label">Phone:</span><span class="value">+${esc(order.customer_phone)}</span></div>
    <div class="row"><span class="label">Address:</span><span class="value">${esc(order.address || 'Visit to boutique')}</span></div>

    <hr class="divider">
    <div class="section-title">Items</div>
    <div class="items">
        ${services.map((s: string) => `<div class="item-row"><span>${esc(s)}</span></div>`).join('')}
    </div>

    <hr class="divider">
    <div class="row"><span class="label">Appointment:</span><span class="value">${esc(order.booking_date)}</span></div>
    <div class="row"><span class="label">Time Slot:</span><span class="value">${esc(order.booking_time)}</span></div>

    <div class="total-row">
        <span>TOTAL</span>
        <span>${order.price ? `₹${order.price.toFixed(0)}` : 'After measurement'}</span>
    </div>

    <hr class="divider">
    <div class="footer">
        Thank you for choosing ${STORE.name}!<br>
        Please retain this receipt.
        ${storeContactLines().map(l => `<br>${esc(l)}`).join('')}
    </div>
</div>

<div class="no-print" style="text-align:center; margin-top:20px;">
    <button onclick="window.print()" style="padding:10px 30px; background:#333; color:white; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; font-family:'Courier New',monospace; letter-spacing:1px;">PRINT RECEIPT</button>
</div>
</body></html>`;

        res.send(receiptHtml);
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate receipt' });
    }
});

// ===== INBOX (customers who chose "Talk to Us") =====

// Open chats, newest activity first
router.get('/inbox', requireAdmin, async (req, res) => {
    try {
        const sessions = await Session.find({ current_step: 'talking_to_staff' }).sort({ updated_at: -1 });
        const chats = await Promise.all(sessions.map(async session => {
            const since = session.handoff_at || session.updated_at;
            const [last, lastIn] = await Promise.all([
                ChatMessage.findOne({ phone_number: session.phone_number, created_at: { $gte: since } }).sort({ created_at: -1 }),
                ChatMessage.findOne({ phone_number: session.phone_number, direction: 'in' }).sort({ created_at: -1 })
            ]);
            return {
                phone: session.phone_number,
                name: session.name || '',
                topic: session.handoff_topic || '',
                since,
                last: last ? { text: last.text || (last.media_type ? `[${last.media_type}]` : ''), direction: last.direction, at: last.created_at } : null,
                // The customer's last word: WhatsApp only allows free replies for 24 hours after it
                lastCustomerAt: lastIn && lastIn.created_at > since ? lastIn.created_at : since,
                waitingReply: !last || last.direction === 'in'
            };
        }));
        res.json(chats);
    } catch (error) {
        console.error('Inbox error:', error);
        res.status(500).json({ error: 'Failed to load the inbox' });
    }
});

// One conversation
router.get('/inbox/:phone', requireAdmin, async (req, res) => {
    try {
        const phone = param(req.params.phone);
        if (!PHONE_PATTERN.test(phone)) {
            res.status(400).json({ error: 'Invalid phone number' });
            return;
        }
        const [session, messages] = await Promise.all([
            Session.findOne({ phone_number: phone }),
            ChatMessage.find({ phone_number: phone }).sort({ created_at: -1 }).limit(100)
        ]);
        res.json({
            phone,
            name: session?.name || '',
            topic: session?.handoff_topic || '',
            open: session?.current_step === 'talking_to_staff',
            messages: messages.reverse()
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load the conversation' });
    }
});

// Reply to the customer on WhatsApp
router.post('/inbox/:phone/reply', requireAdmin, async (req, res) => {
    try {
        const phone = param(req.params.phone);
        const text = String(req.body.text || '').trim();
        if (!PHONE_PATTERN.test(phone) || !text) {
            res.status(400).json({ error: 'Please type a message.' });
            return;
        }
        if (text.length > 4000) {
            res.status(400).json({ error: 'Message is too long for WhatsApp.' });
            return;
        }

        const sent = await whatsappService.sendText(phone, text);
        if (!sent) {
            res.status(502).json({ error: 'WhatsApp did not accept the message. If the customer last wrote more than 24 hours ago, WhatsApp only allows replies once they message again.' });
            return;
        }

        const message = await ChatMessage.create({ phone_number: phone, direction: 'out', text, sent_by: res.locals.user?.name || '' });
        // Keep the chat open while the team is replying
        const session = await Session.findOne({ phone_number: phone });
        if (session) await session.save();

        res.json({ success: true, message });
    } catch (error) {
        console.error('Inbox reply error:', error);
        res.status(500).json({ error: 'Failed to send the reply' });
    }
});

// Done chatting: the bot answers this customer again
router.post('/inbox/:phone/close', requireAdmin, async (req, res) => {
    try {
        const session = await Session.findOne({ phone_number: param(req.params.phone) });
        if (session && session.current_step === 'talking_to_staff') {
            session.current_step = 'start';
            await session.save();
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to close the chat' });
    }
});

// Photos, voice notes and PDFs customers sent. Only types that can't run scripts are passed through.
const SAFE_MEDIA_TYPES = /^(image\/(jpeg|png|webp|gif)|audio\/[\w.+-]+|video\/(mp4|3gpp)|application\/pdf)(;.*)?$/;

router.get('/media/:mediaId', requireAdmin, async (req, res) => {
    try {
        const mediaId = param(req.params.mediaId);
        if (!/^\d+$/.test(mediaId)) {
            res.status(400).json({ error: 'Invalid media id' });
            return;
        }
        const media = await whatsappService.downloadMedia(mediaId);
        if (!media) {
            res.status(404).json({ error: 'This file is no longer available on WhatsApp.' });
            return;
        }
        if (!SAFE_MEDIA_TYPES.test(media.mimeType)) {
            res.status(415).json({ error: 'This file type can only be opened on the phone.' });
            return;
        }
        res.setHeader('Content-Type', media.mimeType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(media.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load the file' });
    }
});

// ===== ONLINE STORE (what the bot shows customers) =====
router.get('/catalog', requireAdmin, async (req, res) => {
    try {
        if (req.query.refresh) await syncCatalog(true);
        const products = await getProducts();
        const ratings: Record<string, unknown> = {};
        for (const p of products) {
            const rating = await getRating(p.id);
            if (rating) ratings[p.id] = rating;
        }
        res.json({
            ...getCatalogStatus(),
            websiteUrl: process.env.WEBSITE_URL || '',
            products,
            ratings
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load the collection' });
    }
});

// ===== LEADS =====

// Get all leads (registered first, then unregistered)
router.get('/leads', requireAdmin, async (req, res) => {
    try {
        const leads = await Lead.find().sort({ type: 1, last_active: -1 });
        res.json(leads);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch leads' });
    }
});

// ===== CSV IMPORT =====
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/leads/import', requireAdmin, upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) {
            res.status(400).json({ error: 'No CSV file uploaded' });
            return;
        }

        const csvContent = req.file.buffer.toString('utf-8');
        const records: Record<string, string>[] = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            bom: true
        }) as Record<string, string>[];

        if (!records.length) {
            res.json({ success: true, imported: 0, skipped: 0, total: 0 });
            return;
        }

        // Log the column names from the CSV for debugging
        const csvColumns: string[] = Object.keys(records[0] as object);
        console.log('CSV columns detected:', csvColumns);

        // Find the name and phone columns dynamically
        const nameCol: string = csvColumns.find(c => /^(name|customername|fullname)$/i.test(c.replace(/[.\s_]/g, ''))) || '';
        const phoneCol: string = csvColumns.find(c => /^(phone|phoneno|mobile|phonenumber|contact|number|cell|tel|whatsapp|mobileno|mobilenumber)$/i.test(c.replace(/[.\s_]/g, ''))) || '';

        console.log(`Using columns — Name: "${nameCol || 'none'}", Phone: "${phoneCol || 'none'}"`);

        // If no phone column found, try positional (first=name, second=phone)
        const usePositional = !phoneCol;
        if (usePositional) {
            console.log('No phone column found by name, using positional: col[0]=name, col[1]=phone');
        }

        let imported = 0;
        let skipped = 0;

        for (const record of records) {
            let name: string = '';
            let phone: string = '';

            if (usePositional && csvColumns.length >= 2) {
                name = record[csvColumns[0] as string] || '';
                phone = record[csvColumns[1] as string] || '';
            } else if (usePositional && csvColumns.length === 1) {
                phone = record[csvColumns[0] as string] || '';
            } else {
                name = nameCol ? (record[nameCol] || '') : '';
                phone = phoneCol ? (record[phoneCol] || '') : '';
            }

            // Clean phone number - remove spaces, dashes, plus sign, parentheses
            phone = phone.replace(/[\s\-\+\(\)]/g, '');

            if (!phone) {
                skipped++;
                continue;
            }

            // Ensure 91 prefix for Indian numbers
            if (phone.length === 10 && !phone.startsWith('91')) {
                phone = '91' + phone;
            }

            // Check for duplicate — try with and without 91 prefix
            const phoneVariants = [phone];
            if (phone.startsWith('91') && phone.length === 12) {
                phoneVariants.push(phone.substring(2)); // without 91
            }

            const existing = await Lead.findOne({ phone_number: { $in: phoneVariants } });
            if (existing) {
                // Update existing lead's phone to the 91-prefixed format
                if (existing.phone_number !== phone) {
                    existing.phone_number = phone;
                }
                if (name && !existing.name) existing.name = name;
                await existing.save();
                skipped++;
            } else {
                await Lead.create({ phone_number: phone, name, type: 'unregistered', source: 'csv_import', last_active: new Date() });
                imported++;
            }
        }

        console.log(`CSV import complete: ${imported} imported, ${skipped} skipped, ${records.length} total`);
        res.json({ success: true, imported, skipped, total: records.length });
    } catch (error) {
        console.error('CSV import error:', error);
        res.status(500).json({ error: 'Failed to import CSV' });
    }
});

// ===== BROADCASTING =====
router.post('/broadcast', requireAdmin, upload.single('mediaFile'), async (req, res) => {
    try {
        const { message, targetType } = req.body; // targetType: 'all', 'registered', 'unregistered'

        if (!message && !req.file) {
            res.status(400).json({ error: 'Please provide a message or media file' });
            return;
        }

        // Build lead filter
        const filter: any = {};
        if (targetType === 'registered') filter.type = 'registered';
        else if (targetType === 'unregistered') filter.type = 'unregistered';

        const leads = await Lead.find(filter);

        if (!leads.length) {
            res.status(400).json({ error: 'No leads found for the selected target' });
            return;
        }

        let mediaId: string | null = null;
        let mediaType: string = '';

        // Upload media if provided
        if (req.file) {
            const mime = req.file.mimetype;
            mediaId = await whatsappService.uploadMedia(req.file.buffer, mime, req.file.originalname);
            if (mime.startsWith('image/')) mediaType = 'image';
            else if (mime.startsWith('video/')) mediaType = 'video';
            else mediaType = 'document';
        }

        let sent = 0;
        let failed = 0;

        for (const lead of leads) {
            try {
                // Personalize message
                const leadName = lead.name || 'Customer';
                const personalizedMessage = (message || '').replace(/\{\{name\}\}/gi, leadName);

                if (mediaId && mediaType === 'image') {
                    await whatsappService.sendImage(lead.phone_number, mediaId, personalizedMessage);
                } else if (mediaId && mediaType === 'video') {
                    await whatsappService.sendVideo(lead.phone_number, mediaId, personalizedMessage);
                } else if (mediaId && mediaType === 'document') {
                    await whatsappService.sendDocument(lead.phone_number, mediaId, req.file!.originalname, personalizedMessage);
                } else if (!(await whatsappService.sendText(lead.phone_number, personalizedMessage))) {
                    throw new Error('WhatsApp did not accept the message');
                }
                sent++;
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                failed++;
                console.error(`Broadcast failed for ${lead.phone_number}:`, err);
            }
        }

        res.json({ success: true, sent, failed, total: leads.length });
    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({ error: 'Failed to send broadcast' });
    }
});

// ===== DELETE LEADS =====

// Delete leads in bulk by source or type (must be before :id route)
router.delete('/leads/bulk/:filter', requireAdmin, async (req, res) => {
    try {
        const filter = param(req.params.filter);
        let result;
        if (filter === 'csv') {
            result = await Lead.deleteMany({ source: 'csv_import' });
        } else if (filter === 'unregistered') {
            result = await Lead.deleteMany({ type: 'unregistered' });
        } else {
            res.status(400).json({ error: 'Invalid filter. Use "csv" or "unregistered".' });
            return;
        }
        res.json({ success: true, deleted: result.deletedCount });
    } catch (error) {
        res.status(500).json({ error: 'Failed to bulk delete leads' });
    }
});

// Delete a single lead by ID
router.delete('/leads/:id', requireAdmin, async (req, res) => {
    try {
        await Lead.findByIdAndDelete(param(req.params.id));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete lead' });
    }
});

export default router;
