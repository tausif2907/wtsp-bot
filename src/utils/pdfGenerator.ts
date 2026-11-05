import puppeteer from 'puppeteer';
import { STORE } from '../config/store';
import { escapeHtml as esc } from './html';
import { formatPrice } from '../services/catalog';

// Invoice / booking slip: sent to the customer as a PDF on WhatsApp and printed from the dashboard.
// Stitching is priced after measurement; until then the document is a booking slip, not an invoice.

const INK = '#101828';
const MUTED = '#667085';
const LINE = '#e4e7ec';
const { primary: ACCENT, soft: ACCENT_SOFT } = STORE.colors;

// Same journey colours as the dashboard's status badges
const STATUS_COLOURS: Record<string, [string, string]> = {
    order_received: ['#eff4ff', '#1d4ed8'],
    in_stitching: ['#f4f0ff', '#6d28d9'],
    ready: ['#fffaeb', '#b54708'],
    out_for_delivery: ['#ecfdff', '#0e7090'],
    delivered: ['#ecfdf3', '#067647'],
    cancelled: ['#fef3f2', '#b42318']
};

/** "919876543210" -> "+91 98765 43210" */
function formatPhone(phone: string): string {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
    return digits ? `+${digits}` : '';
}

const shortId = (orderId: string) => (String(orderId || '').split('-')[0] || '').toUpperCase();

export async function generateInvoiceHtml(order: any, statusLabel: string, mapUrl: string): Promise<string> {
    const isPriced = (order.price || 0) > 0;
    const isPickup = order.appointment_type !== 'visit';
    const docType = isPriced ? 'Invoice' : 'Booking slip';
    const issued = new Date(order.created_at || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const services = String(order.service || '').split(',').map(s => s.trim()).filter(Boolean);
    const [pillBg, pillText] = STATUS_COLOURS[order.status] || ['#f2f4f7', '#344054'];

    const where = isPickup
        ? `<div>${esc(order.address || 'Your address')}</div>`
        : `<div>${esc(STORE.name)}, ${esc(STORE.address)}</div>`;
    const mapLink = mapUrl ? `<a href="${esc(mapUrl)}">View on Google Maps</a>` : '';

    const note = isPriced
        ? `Thank you for choosing ${esc(STORE.name)}. We'll let you know on WhatsApp as soon as your outfit is ready.`
        : isPickup
            ? 'Our team will collect your fabric and a sample garment at the time above. Your price is confirmed after measurement and shared on WhatsApp.'
            : 'Please bring your fabric and a well-fitting sample garment or a design photo. Your price is confirmed after measurement and shared on WhatsApp.';

    const contact = [STORE.address, STORE.phone, STORE.email, STORE.instagram, process.env.WEBSITE_URL].filter(Boolean).map(v => esc(v as string));

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>${esc(STORE.name)} ${docType} ${esc(order.invoice_number || '')}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
    @page { size: A4; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', 'Segoe UI', Arial, sans-serif; color: ${INK}; background: #eef1f4; font-size: 13px; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .sheet { width: 210mm; min-height: 297mm; margin: 24px auto; background: #fff; display: flex; flex-direction: column; box-shadow: 0 8px 30px rgba(16, 24, 40, 0.08); }
    .stripe { height: 6px; background: ${ACCENT}; }
    .content { padding: 44px 52px 32px; flex: 1; display: flex; flex-direction: column; }

    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .mark { width: 46px; height: 46px; border-radius: 12px; background: ${ACCENT}; color: #fff; display: flex; align-items: center; justify-content: center; font-family: 'Fraunces', Georgia, serif; font-size: 19px; font-weight: 600; letter-spacing: 0.5px; }
    .brand-name { font-family: 'Fraunces', Georgia, serif; font-size: 25px; font-weight: 600; letter-spacing: -0.2px; line-height: 1.15; }
    .tagline { color: ${MUTED}; font-size: 12px; margin-top: 2px; }
    .doc { text-align: right; }
    .doc-type { font-size: 11px; font-weight: 600; letter-spacing: 1.6px; text-transform: uppercase; color: ${ACCENT}; }
    .doc-no { font-size: 20px; font-weight: 700; margin-top: 4px; letter-spacing: -0.2px; }

    .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 32px; padding: 16px 0; border-top: 1px solid ${LINE}; border-bottom: 1px solid ${LINE}; }
    .label { display: block; font-size: 10.5px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: ${MUTED}; margin-bottom: 4px; }
    .value { font-weight: 600; }
    .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; background: ${pillBg}; color: ${pillText}; }

    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 28px; }
    .party { background: #f9fafb; border: 1px solid ${LINE}; border-radius: 10px; padding: 16px 18px; }
    .party strong { display: block; font-size: 14px; margin-bottom: 2px; }
    .party div { color: #344054; }
    .party a { color: ${ACCENT}; font-weight: 600; text-decoration: none; display: inline-block; margin-top: 6px; }

    table { width: 100%; border-collapse: collapse; margin-top: 30px; }
    th { text-align: left; font-size: 10.5px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: ${MUTED}; padding: 0 0 10px; border-bottom: 1.5px solid ${INK}; }
    td { padding: 13px 0; border-bottom: 1px solid ${LINE}; vertical-align: top; }
    .num { width: 40px; color: ${MUTED}; }
    .r { text-align: right; }
    .desc { color: ${MUTED}; font-size: 12px; }

    .totals { margin-top: 18px; margin-left: auto; width: 300px; }
    .totals .row { display: flex; justify-content: space-between; padding: 6px 0; color: #344054; }
    .totals .due { margin-top: 6px; padding: 14px 16px; border-radius: 10px; background: ${ACCENT_SOFT}; color: ${INK}; align-items: baseline; }
    .totals .due span:first-child { font-weight: 600; }
    .totals .due span:last-child { font-size: 22px; font-weight: 700; color: ${ACCENT}; letter-spacing: -0.3px; }
    .totals .pending span:last-child { font-size: 14px; }

    .note { margin-top: 30px; padding: 14px 16px; border-left: 3px solid ${ACCENT}; background: #f9fafb; color: #344054; border-radius: 0 8px 8px 0; }

    .foot { margin-top: auto; padding-top: 22px; border-top: 1px solid ${LINE}; display: flex; justify-content: space-between; gap: 24px; font-size: 11.5px; color: ${MUTED}; }
    .foot strong { color: ${INK}; font-weight: 600; }
    .foot a { color: ${ACCENT}; text-decoration: none; }

    @media print {
        body { background: #fff; }
        .sheet { margin: 0; box-shadow: none; }
        .no-print { display: none !important; }
    }
</style>
</head><body>
<div class="sheet">
    <div class="stripe"></div>
    <div class="content">
        <header class="head">
            <div class="brand">
                <div class="mark">${esc(STORE.shortName)}</div>
                <div>
                    <div class="brand-name">${esc(STORE.name)}</div>
                    <div class="tagline">${esc(STORE.tagline)}</div>
                </div>
            </div>
            <div class="doc">
                <div class="doc-type">${docType}</div>
                <div class="doc-no">${esc(order.invoice_number || 'N/A')}</div>
            </div>
        </header>

        <section class="meta">
            <div><span class="label">Issued</span><span class="value">${esc(issued)}</span></div>
            <div><span class="label">Order ID</span><span class="value">${esc(shortId(order.order_id))}</span></div>
            <div><span class="label">Status</span><span class="pill">${esc(statusLabel)}</span></div>
        </section>

        <section class="parties">
            <div class="party">
                <span class="label">Billed to</span>
                <strong>${esc(order.customer_name || 'Customer')}</strong>
                <div>${esc(formatPhone(order.customer_phone || order.phone_number))}</div>
            </div>
            <div class="party">
                <span class="label">Appointment</span>
                <strong>${isPickup ? 'Home pickup' : 'Measurement visit'}</strong>
                <div>${esc(order.booking_date)} &middot; ${esc(order.booking_time)}</div>
                ${where}
                ${mapLink}
            </div>
        </section>

        <table>
            <thead><tr><th class="num">#</th><th>Service</th><th class="r">Qty</th></tr></thead>
            <tbody>
                ${services.map((s, i) => `<tr><td class="num">${i + 1}</td><td>${esc(s)}<div class="desc">Cut and stitched to your measurements</div></td><td class="r">1</td></tr>`).join('')}
            </tbody>
        </table>

        <section class="totals">
            ${isPriced
                ? `<div class="row"><span>Stitching charges</span><span>${formatPrice(order.price)}</span></div>
                   <div class="row due"><span>Total</span><span>${formatPrice(order.price)}</span></div>`
                : `<div class="row due pending"><span>Total</span><span>After measurement</span></div>`}
        </section>

        <div class="note">${note}</div>

        <footer class="foot">
            <div><strong>${esc(STORE.name)}</strong><br>${contact.join('<br>')}</div>
            <div class="r">Questions? Reply to us on WhatsApp.${STORE.mapsLink ? `<br><a href="${esc(STORE.mapsLink)}">Directions to the boutique</a>` : ''}</div>
        </footer>
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
        preferCSSPageSize: true,
        margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
    });

    await browser.close();

    // Puppeteer returns a Uint8Array in newer versions natively sometimes, but Buffer.from handles it safely
    return Buffer.from(pdfBuffer);
}
