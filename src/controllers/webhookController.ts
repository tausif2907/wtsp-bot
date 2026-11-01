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

// Deduplication cache: stores processed message IDs to prevent duplicates
const processedMessages = new Set<string>();
const MAX_CACHE_SIZE = 1000;

export const handleIncomingMessage = async (req: Request, res: Response) => {
    // IMMEDIATELY respond 200 so WhatsApp doesn't retry
    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;
            const message = value?.messages?.[0];

            if (message) {
                const messageId = message.id;

                // Skip if we've already processed this message
                if (processedMessages.has(messageId)) {
                    console.log(`Duplicate message ${messageId} - skipping`);
                    return;
                }

                // Mark as processed
                processedMessages.add(messageId);

                // Prevent memory leak - clear old entries when cache gets too large
                if (processedMessages.size > MAX_CACHE_SIZE) {
                    const iterator = processedMessages.values();
                    for (let i = 0; i < 500; i++) {
                        processedMessages.delete(iterator.next().value as string);
                    }
                }

                const from = message.from;
                console.log(`Received message from ${from} (id: ${messageId})`);

                await flowController.handleMessage(message);
            }
        }
    } catch (error) {
        console.error('Error handling incoming webhook:', error);
    }
};
