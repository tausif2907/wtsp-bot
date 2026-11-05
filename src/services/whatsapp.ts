import axios from 'axios';
import FormData from 'form-data';

// Meta retires each Graph API version about two years after release; keep this current
const GRAPH_API = 'https://graph.facebook.com/v25.0';

export class WhatsAppService {
    private token: string;
    private phoneId: string;

    constructor() {
        this.token = process.env.WHATSAPP_TOKEN || '';
        this.phoneId = process.env.WHATSAPP_PHONE_ID || '';
    }

    private get baseUrl() {
        return `${GRAPH_API}/${this.phoneId}/messages`;
    }

    private get headers() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
        };
    }

    /** Returns false when WhatsApp refuses the message (for example outside the 24-hour reply window). */
    async sendText(to: string, text: string): Promise<boolean> {
        try {
            await axios.post(
                this.baseUrl,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'text',
                    text: { preview_url: false, body: text }
                },
                { headers: this.headers }
            );
            return true;
        } catch (error: any) {
            console.error('Error sending WhatsApp text:', error.response?.data || error.message);
            return false;
        }
    }

    async sendInteractiveList(to: string, text: string, listData: { buttonText: string, title?: string, rows: { id: string, title: string, description?: string }[] }) {
        try {
            await axios.post(
                this.baseUrl,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'interactive',
                    interactive: {
                        type: 'list',
                        body: { text },
                        action: {
                            button: listData.buttonText,
                            sections: [
                                {
                                    title: listData.title || 'Options',
                                    rows: listData.rows
                                }
                            ]
                        }
                    }
                },
                { headers: this.headers }
            );
        } catch (error: any) {
            console.error('Error sending WhatsApp interactive list:', error.response?.data || error.message);
        }
    }

    async sendInteractiveButtons(to: string, text: string, buttons: { id: string, title: string }[]) {
        try {
            await axios.post(
                this.baseUrl,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'interactive',
                    interactive: {
                        type: 'button',
                        body: { text },
                        action: {
                            buttons: buttons.map(btn => ({
                                type: 'reply',
                                reply: {
                                    id: btn.id,
                                    title: btn.title
                                }
                            }))
                        }
                    }
                },
                { headers: this.headers }
            );
        } catch (error: any) {
            console.error('Error sending WhatsApp interactive buttons:', error.response?.data || error.message);
        }
    }

    async uploadMedia(fileBuffer: Buffer, mimeType: string, filename: string = 'document.pdf'): Promise<string | null> {
        try {
            const formData = new FormData();
            formData.append('file', fileBuffer, {
                filename,
                contentType: mimeType,
            });
            formData.append('messaging_product', 'whatsapp');

            const uploadUrl = `${GRAPH_API}/${this.phoneId}/media`;
            const response = await axios.post(uploadUrl, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Bearer ${this.token}`,
                }
            });
            return response.data.id;
        } catch (error: any) {
            console.error('Error uploading WhatsApp media:', error.response?.data || error.message);
            return null;
        }
    }

    /** Fetches a photo or file a customer sent. WhatsApp media links only work with our token. */
    async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string } | null> {
        try {
            const meta = await axios.get(`${GRAPH_API}/${mediaId}`, { headers: this.headers });
            const file = await axios.get(meta.data.url, {
                headers: { 'Authorization': `Bearer ${this.token}` },
                responseType: 'arraybuffer'
            });
            return { data: Buffer.from(file.data), mimeType: meta.data.mime_type || 'application/octet-stream' };
        } catch (error: any) {
            console.error('Error downloading WhatsApp media:', error.response?.data || error.message);
            return null;
        }
    }

    async sendDocument(to: string, mediaId: string, filename: string, caption?: string) {
        try {
            await axios.post(
                this.baseUrl,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'document',
                    document: {
                        id: mediaId,
                        filename: filename,
                        caption: caption
                    }
                },
                { headers: this.headers }
            );
        } catch (error: any) {
            console.error('Error sending WhatsApp document:', error.response?.data || error.message);
        }
    }

    async sendImage(to: string, mediaId: string, caption?: string) {
        try {
            await axios.post(
                this.baseUrl,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'image',
                    image: {
                        id: mediaId,
                        caption: caption || ''
                    }
                },
                { headers: this.headers }
            );
        } catch (error: any) {
            console.error('Error sending WhatsApp image:', error.response?.data || error.message);
        }
    }

    async sendImageLink(to: string, link: string, caption?: string) {
        try {
            await axios.post(
                this.baseUrl,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'image',
                    image: {
                        link,
                        caption: caption || ''
                    }
                },
                { headers: this.headers }
            );
        } catch (error: any) {
            console.error('Error sending WhatsApp image link:', error.response?.data || error.message);
        }
    }

    async sendVideo(to: string, mediaId: string, caption?: string) {
        try {
            await axios.post(
                this.baseUrl,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'video',
                    video: {
                        id: mediaId,
                        caption: caption || ''
                    }
                },
                { headers: this.headers }
            );
        } catch (error: any) {
            console.error('Error sending WhatsApp video:', error.response?.data || error.message);
        }
    }
}

export const whatsappService = new WhatsAppService();
