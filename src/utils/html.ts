// Customer names and addresses come from WhatsApp, so escape them before putting them in HTML
export function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
