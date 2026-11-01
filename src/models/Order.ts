import mongoose, { Document, Schema } from 'mongoose';

export interface IOrder extends Document {
    order_id: string;
    customer_phone: string;
    customer_name: string;
    service: string;
    booking_date: string;
    booking_time: string;
    latitude?: number;
    longitude?: number;
    address?: string;
    appointment_type: string;
    price: number;
    invoice_number: string;
    status: string;
    created_at: Date;
}

const orderSchema = new Schema({
    order_id: { type: String, required: true, unique: true },
    customer_phone: { type: String, required: true },
    customer_name: { type: String, required: true },
    service: { type: String, required: true },
    booking_date: { type: String, required: true },
    booking_time: { type: String, required: true },
    // Only set for home pickups; shop-visit appointments have no address
    latitude: { type: Number, required: false },
    longitude: { type: Number, required: false },
    address: { type: String, required: false },
    appointment_type: { type: String, enum: ['visit', 'pickup'], default: 'pickup' },
    price: { type: Number, required: true },
    invoice_number: { type: String, required: true },
    status: {
        type: String,
        enum: [
            'order_received',
            'out_for_delivery',
            'delivered',
            'cancelled'
        ],
        default: 'order_received'
    },
    created_at: { type: Date, default: Date.now }
});

export const Order = mongoose.model<IOrder>('Order', orderSchema);
