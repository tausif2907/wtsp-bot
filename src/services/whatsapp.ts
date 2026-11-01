import axios from 'axios';

export class WhatsAppService {
    private token: string;
    private phoneId: string;

    constructor() {
        this.token = process.env.WHATSAPP_TOKEN || '';
        this.phoneId = process.env.WHATSAPP_PHONE_ID || '';
    }

    private get baseUrl() {
        return `https://graph.facebook.com/v18.0/${this.phoneId}/messages`;
    }

    private get headers() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
        };
    }

    async sendText(to: string, text: string) {
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
        } catch (error: any) {
            console.error('Error sending WhatsApp text:', error.response?.data || error.message);
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
}

export const whatsappService = new WhatsAppService();
