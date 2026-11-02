import { STORE } from '../config/store';
import { formatPrice } from './catalog';

// The order journey, in order. The dashboard and the delivery page use the same values.
export const ORDER_STATUSES = [
    { value: 'order_received', label: 'Booked' },
    { value: 'in_stitching', label: 'Stitching in Progress' },
    { value: 'ready', label: 'Outfit Ready' },
    { value: 'out_for_delivery', label: 'Out for Delivery' },
    { value: 'delivered', label: 'Delivered' },
    { value: 'cancelled', label: 'Cancelled' }
];

export const STATUS_LABELS: Record<string, string> = Object.fromEntries(ORDER_STATUSES.map(s => [s.value, s.label]));

export const shortOrderId = (orderId: string) => (orderId.split('-')[0] || '').toUpperCase();

interface OrderLike {
    order_id: string;
    service: string;
    status: string;
    price: number;
    appointment_type?: string;
}

/** WhatsApp message sent to the customer when the team changes the order status. */
export function statusUpdateMessage(order: OrderLike): string {
    const id = shortOrderId(order.order_id);
    const pickup = order.appointment_type === 'pickup';
    const messages: Record<string, string> = {
        order_received: `We have received your booking ${id}. ${pickup ? 'Our team will come for the pickup at your chosen time.' : 'We look forward to seeing you at the boutique.'}`,
        in_stitching: 'Your measurements are with our master tailors and your outfit is now being stitched ✂️',
        ready: pickup
            ? 'Your outfit is ready! 🎉 We will contact you shortly to arrange delivery.'
            : `Your outfit is ready! 🎉 Please visit the boutique for your trial and collection.\n\n📍 ${STORE.address}\n🕘 ${STORE.hoursText.replace('\n', ' | ')}`,
        out_for_delivery: `Your outfit is on its way! 🛵 Order ${id} is out for delivery.`,
        delivered: `Your order ${id} has been delivered. We hope you love the fit! Thank you for choosing ${STORE.name} 🌸`,
        cancelled: `Your order ${id} has been cancelled. Please reply to this chat if you need any help.`
    };
    const label = STATUS_LABELS[order.status] || order.status;

    return [
        `*${STORE.name} — Order Update*`,
        '',
        `Order ID: ${id}`,
        `Service: ${order.service}`,
        `Status: *${label}*`,
        '',
        messages[order.status] || `Your order status has been updated to: ${label}.`
    ].join('\n');
}

/** WhatsApp message sent when the team sets the price after measurement. */
export function priceQuoteMessage(order: OrderLike): string {
    return [
        `*${STORE.name} — Your Price*`,
        '',
        `Order ID: ${shortOrderId(order.order_id)}`,
        `Service: ${order.service}`,
        `Price: *${formatPrice(order.price)}*`,
        '',
        `Reply to this chat if you have any questions. Thank you for choosing ${STORE.name} 🌸`
    ].join('\n');
}
