import mongoose, { Document, Schema } from 'mongoose';

export interface IOrder extends Document {
    order_id: string;
    customer_phone: string;
    service: string;
    booking_date: string;
    booking_time: string;
    latitude: number;
    longitude: number;
    status: string;
    created_at: Date;
}

const orderSchema = new Schema({
    order_id: { type: String, required: true, unique: true },
    customer_phone: { type: String, required: true },
    service: { type: String, required: true },
    booking_date: { type: String, required: true },
    booking_time: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    status: { type: String, enum: ['confirmed', 'completed', 'cancelled'], default: 'confirmed' },
    created_at: { type: Date, default: Date.now }
});

export const Order = mongoose.model<IOrder>('Order', orderSchema);
