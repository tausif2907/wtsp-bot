import mongoose, { Document, Schema } from 'mongoose';

export interface ILead extends Document {
    phone_number: string;
    name: string;
    type: 'registered' | 'unregistered';
    source: 'whatsapp' | 'csv_import';
    last_active: Date;
    created_at: Date;
}

const leadSchema = new Schema({
    phone_number: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    type: { type: String, enum: ['registered', 'unregistered'], default: 'unregistered' },
    source: { type: String, enum: ['whatsapp', 'csv_import'], default: 'whatsapp' },
    last_active: { type: Date, default: Date.now },
    created_at: { type: Date, default: Date.now }
});

export const Lead = mongoose.model<ILead>('Lead', leadSchema);
