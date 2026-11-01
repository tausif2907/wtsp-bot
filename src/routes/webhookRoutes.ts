import { Router } from 'express';
import { verifyWebhook, handleIncomingMessage } from '../controllers/webhookController';

const router = Router();

// GET request is used by Meta for webhook verification
router.get('/', verifyWebhook);

// POST request is used to receive messages
router.post('/', handleIncomingMessage);

export default router;
