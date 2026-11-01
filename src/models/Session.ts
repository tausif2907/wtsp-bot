import mongoose, { Document, Schema } from 'mongoose';

export interface ISession extends Document {
    phone_number: string;
    current_step: string;
    selected_service?: string;
    selected_date?: string;
    selected_time?: string;
    name?: string;
    updated_at: Date;
}

const sessionSchema = new Schema({
    phone_number: { type: String, required: true, unique: true },
    current_step: { type: String, required: true, default: 'start' },
    selected_service: { type: String, required: false },
    selected_date: { type: String, required: false },
    selected_time: { type: String, required: false },
    name: { type: String, required: false },
    updated_at: { type: Date, default: Date.now }
});

// Setting a 24-hour TTL for abandoned sessions
sessionSchema.index({ updated_at: 1 }, { expireAfterSeconds: 86400 });

sessionSchema.pre('save', function (next) {
    this.updated_at = new Date();
    next();
});

export const Session = mongoose.model<ISession>('Session', sessionSchema);
