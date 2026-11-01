import { Router } from 'express';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { whatsappService } from '../services/whatsapp';
import { STATUS_LABELS } from '../services/flowController';
import { STORE, storeContactLines } from '../config/store';
import { generateInvoiceHtml } from '../utils/pdfGenerator';

const router = Router();

// Get all customers
router.get('/customers', async (req, res) => {
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

        const validStatuses = [
            'order_received', 'out_for_delivery', 'delivered', 'cancelled'
        ];

        if (!validStatuses.includes(status)) {
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

        // Send WhatsApp notification to customer
        const shortId = (order.order_id.split('-')[0] || '').toUpperCase();
        const statusLabel = STATUS_LABELS[status] || status;
        const statusMessages: Record<string, string> = {
            'order_received': `Your order ${shortId} has been received. Our team will be in touch for pickup shortly.`,
            'out_for_delivery': `Your outfit is ready! 🎉 Order ${shortId} is out for delivery and our agent is on the way.`,
            'delivered': `Your order ${shortId} has been delivered. We hope you love the fit! Thank you for choosing ${STORE.name} 🌸`,
            'cancelled': `Your order ${shortId} has been cancelled. Please reply to this chat if you need any help.`
        };

        const notificationMsg = [
            `*${STORE.name} — Order Update*`,
            ``,
            `Order ID: ${shortId}`,
            `Service: ${order.service}`,
            `Status: *${statusLabel}*`,
            ``,
            statusMessages[status] || `Your order status has been updated to: ${statusLabel}.`
        ].join('\n');

        await whatsappService.sendText(order.customer_phone, notificationMsg);

        res.json({ success: true, order });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Analytics — service popularity
router.get('/analytics', async (req, res) => {
    try {
        const orders = await Order.find();
        const serviceCounts: Record<string, number> = {};
        const statusCounts: Record<string, number> = {};
        let totalRevenue = 0;

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
            totalRevenue += order.price || 0;
        });

        res.json({
            serviceCounts,
            statusCounts,
            totalRevenue,
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

        const shortId = (order.order_id.split('-')[0] || '').toUpperCase();
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
    <div class="row"><span class="label">Invoice:</span><span class="value">${order.invoice_number || 'N/A'}</span></div>

    <hr class="divider">
    <div class="section-title">Customer</div>
    <div class="row"><span class="label">Name:</span><span class="value">${order.customer_name}</span></div>
    <div class="row"><span class="label">Phone:</span><span class="value">+${order.customer_phone}</span></div>
    <div class="row"><span class="label">Address:</span><span class="value">${order.address || 'Visit to boutique'}</span></div>

    <hr class="divider">
    <div class="section-title">Items</div>
    <div class="items">
        ${services.map((s: string) => `<div class="item-row"><span>${s}</span></div>`).join('')}
    </div>

    <hr class="divider">
    <div class="row"><span class="label">Appointment:</span><span class="value">${order.booking_date}</span></div>
    <div class="row"><span class="label">Time Slot:</span><span class="value">${order.booking_time}</span></div>

    <div class="total-row">
        <span>TOTAL</span>
        <span>${order.price ? `₹${order.price.toFixed(0)}` : 'After measurement'}</span>
    </div>

    <hr class="divider">
    <div class="footer">
        Thank you for choosing ${STORE.name}!<br>
        Please retain this receipt.
        ${storeContactLines().map(l => `<br>${l}`).join('')}
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

// ===== LEADS =====
import { Lead } from '../models/Lead';

// Get all leads (registered first, then unregistered)
router.get('/leads', async (req, res) => {
    try {
        const leads = await Lead.find().sort({ type: 1, last_active: -1 });
        res.json(leads);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch leads' });
    }
});

// ===== CSV IMPORT =====
import multer from 'multer';
import { parse } from 'csv-parse/sync';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/leads/import', upload.single('csvFile'), async (req, res) => {
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
router.post('/broadcast', upload.single('mediaFile'), async (req, res) => {
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
                } else {
                    await whatsappService.sendText(lead.phone_number, personalizedMessage);
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
router.delete('/leads/bulk/:filter', async (req, res) => {
    try {
        const { filter } = req.params;
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
router.delete('/leads/:id', async (req, res) => {
    try {
        await Lead.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete lead' });
    }
});

export default router;
