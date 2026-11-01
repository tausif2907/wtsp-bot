import puppeteer from 'puppeteer';
import { STORE, storeContactLines } from '../config/store';

export async function generateInvoiceHtml(order: any, statusLabel: string, mapUrl: string): Promise<string> {
    // Stitching is priced after measurement; until then this is a booking slip rather than an invoice
    const isPriced = (order.price || 0) > 0;
    const isPickup = order.appointment_type !== 'visit';
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Montserrat:wght@400;600&display=swap" rel="stylesheet">
<title>${STORE.name} ${isPriced ? 'Invoice' : 'Booking'} - ${order.invoice_number || 'N/A'}</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Montserrat', 'Segoe UI', Arial, sans-serif; padding: 40px; color: #2b1a1f; background: #fff; }
    .invoice { max-width: 700px; margin: 0 auto; border: 2px solid ${STORE.colors.primary}; outline: 1px solid ${STORE.colors.accent}; outline-offset: -8px; padding: 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid ${STORE.colors.accent}; }
    .header h1 { font-family: 'Playfair Display', Georgia, serif; font-size: 30px; letter-spacing: 2px; color: ${STORE.colors.primary}; }
    .header .inv-details { text-align: right; font-size: 14px; color: #555; }
    .header .inv-details strong { color: ${STORE.colors.primary}; }
    .section { margin-bottom: 25px; }
    .section h3 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: ${STORE.colors.primary}; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid #eee; }
    .section p { font-size: 14px; line-height: 1.8; color: #333; }
    .section p strong { color: #2b1a1f; }
    .amount-box { background: ${STORE.colors.soft}; border: 1px solid ${STORE.colors.accent}; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0; }
    .amount-box .label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #666; }
    .amount-box .value { font-size: 32px; font-weight: 700; color: ${STORE.colors.primary}; margin-top: 5px; }
    .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #888; }
    .status { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; background: #e8f5e9; color: #2e7d32; }
    @media print { body { padding: 0; } .invoice { border: none; } .no-print { display: none; } }
</style>
</head><body>
<div class="invoice">
    <div class="header">
        <div>
            <h1>${STORE.name.toUpperCase()}</h1>
            <p style="font-size:13px; color:#888; margin-top:4px;">${STORE.tagline}</p>
        </div>
        <div class="inv-details">
            <p><strong>${isPriced ? 'Invoice' : 'Booking'} No:</strong> ${order.invoice_number || 'N/A'}</p>
            <p><strong>Order ID:</strong> ${(order.order_id.split('-')[0] || '').toUpperCase()}</p>
            <p><strong>Date:</strong> ${new Date(order.created_at || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</p>
            <p>Status: <span class="status">${statusLabel}</span></p>
        </div>
    </div>
    <div class="section">
        <h3>Customer Details</h3>
        <p><strong>Name:</strong> ${order.customer_name}</p>
        <p><strong>Phone:</strong> +${order.customer_phone || order.phone_number || ''}</p>
        ${isPickup ? `<p><strong>Pickup Address:</strong> ${order.address || '—'}</p>` : ''}
        ${mapUrl ? `<p><strong>Location:</strong> <a href="${mapUrl}" target="_blank">View on Google Maps</a></p>` : ''}
    </div>
    <div class="section">
        <h3>Order Details</h3>
        <p><strong>Service:</strong> ${order.service}</p>
        <p><strong>Appointment:</strong> ${isPickup ? 'Home pickup' : `Measurement visit at ${STORE.address}`}</p>
        <p><strong>Date:</strong> ${order.booking_date}</p>
        <p><strong>Time:</strong> ${order.booking_time}</p>
    </div>
    <div class="amount-box">
        <div class="label">Total Amount</div>
        <div class="value">${isPriced ? `₹${order.price.toFixed(2)}` : '<span style="font-size:18px;">Shared after measurement</span>'}</div>
    </div>
    <div class="footer">
        <p>Thank you for choosing ${STORE.name}.</p>
        <p style="margin-top: 4px;">For queries, reply to us on WhatsApp.</p>
        ${storeContactLines().map(l => `<p style="margin-top: 4px;">${l}</p>`).join('')}
    </div>
</div>
</body></html>`;
}

export async function generatePdfBuffer(htmlContent: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
        headless: true, // changed for puppeteer v22+ if needed, but 'true' is fine usually
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
    });

    await browser.close();

    // Puppeteer returns a Uint8Array in newer versions natively sometimes, but Buffer.from handles it safely
    return Buffer.from(pdfBuffer);
}
