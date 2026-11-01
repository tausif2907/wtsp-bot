import mongoose, { Document, Schema } from 'mongoose';

export interface ICartItem {
    service: string;
    price: number;
}

export interface ISession extends Document {
    phone_number: string;
    current_step: string;
    selected_service?: string;
    selected_date?: string;
    selected_time?: string;
    name?: string;
    location_lat?: number;
    location_lng?: number;
    address?: string;
    appointment_type?: string;
    browse_category?: string;
    product_id?: string;
    cart: ICartItem[];
    updated_at: Date;
}

const cartItemSchema = new Schema({
    service: { type: String, required: true },
    price: { type: Number, required: true }
}, { _id: false });

const sessionSchema = new Schema({
    phone_number: { type: String, required: true, unique: true },
    current_step: { type: String, required: true, default: 'start' },
    selected_service: { type: String, required: false },
    selected_date: { type: String, required: false },
    selected_time: { type: String, required: false },
    name: { type: String, required: false },
    location_lat: { type: Number, required: false },
    location_lng: { type: Number, required: false },
    address: { type: String, required: false },
    appointment_type: { type: String, required: false },
    browse_category: { type: String, required: false },
    product_id: { type: String, required: false },
    cart: { type: [cartItemSchema], default: [] },
    updated_at: { type: Date, default: Date.now }
});

// Setting a 24-hour TTL for abandoned sessions
sessionSchema.index({ updated_at: 1 }, { expireAfterSeconds: 86400 });

sessionSchema.pre('save', function () {
    this.updated_at = new Date();
});

export const Session = mongoose.model<ISession>('Session', sessionSchema);
