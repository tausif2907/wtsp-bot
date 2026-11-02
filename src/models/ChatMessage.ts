import mongoose, { Document, Schema } from 'mongoose';

// Messages exchanged while a customer is talking to the boutique team,
// shown in the dashboard inbox (the bot's WhatsApp number can't be used in the WhatsApp app).
export interface IChatMessage extends Document {
    phone_number: string;
    direction: 'in' | 'out';
    text: string;
    media_id?: string;
    media_type?: string;
    sent_by?: string;
    created_at: Date;
}

const chatMessageSchema = new Schema({
    phone_number: { type: String, required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    text: { type: String, default: '' },
    media_id: { type: String, required: false },
    media_type: { type: String, required: false },
    sent_by: { type: String, required: false },
    created_at: { type: Date, default: Date.now }
});

chatMessageSchema.index({ phone_number: 1, created_at: 1 });

export const ChatMessage = mongoose.model<IChatMessage>('ChatMessage', chatMessageSchema);
