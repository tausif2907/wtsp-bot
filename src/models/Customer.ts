import mongoose, { Document, Schema } from 'mongoose';

export interface ICustomer extends Document {
    phone_number: string;
    name: string;
    location_lat: number;
    location_lng: number;
    address: string;
    created_at: Date;
}

const customerSchema = new Schema({
    phone_number: { type: String, required: true, unique: true },
    name: { type: String, required: false },
    location_lat: { type: Number, required: false },
    location_lng: { type: Number, required: false },
    address: { type: String, required: false },
    created_at: { type: Date, default: Date.now }
});

export const Customer = mongoose.model<ICustomer>('Customer', customerSchema);
