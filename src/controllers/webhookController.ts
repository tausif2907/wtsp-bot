import { Request, Response } from 'express';
import { flowController } from '../services/flowController';

export const verifyWebhook = (req: Request, res: Response) => {
    const verify_token = process.env.WHATSAPP_VERIFY_TOKEN;

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === verify_token) {
            console.log('WEBHOOK VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
};

export const handleIncomingMessage = async (req: Request, res: Response) => {
    try {
        const body = req.body;

        // Check if this is an event from the WhatsApp Business Account
        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;
            const message = value?.messages?.[0];

            if (message) {
                const phoneNumberId = value.metadata.phone_number_id;
                const from = message.from; // sender's phone number

                console.log(`Received message from ${from}`);

                // In the next step, we will delegate this to the flow controller.
                await flowController.handleMessage(message);
            }
            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    } catch (error) {
        console.error('Error handling incoming webhook:', error);
        res.sendStatus(500);
    }
};
