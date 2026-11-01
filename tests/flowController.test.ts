import { flowController } from '../src/services/flowController';
import { Session } from '../src/models/Session';
import { Customer } from '../src/models/Customer';
import { Order } from '../src/models/Order';
import { whatsappService } from '../src/services/whatsapp';
import mongoose from 'mongoose';

jest.mock('../src/services/whatsapp', () => ({
    whatsappService: {
        sendText: jest.fn(),
        sendInteractiveList: jest.fn()
    }
}));

describe('FlowController State Machine', () => {
    beforeAll(async () => {
        // Connect to an in-memory or test database if needed,
        // For unit testing we'll just mock mongoose methods.
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should create a new session and send start menu on first message', async () => {
        // Mock findOne to return null (no existing session)
        jest.spyOn(Session, 'findOne').mockResolvedValue(null);

        let savedSession: any = null;

        // Mock Session constructor and save
        jest.spyOn(Session.prototype, 'save').mockImplementation(function (this: any) {
            savedSession = this;
            return Promise.resolve(this);
        });

        const mockMessage = {
            from: '1234567890',
            type: 'text',
            text: { body: 'Hi' }
        };

        await flowController.handleMessage(mockMessage);

        expect(Session.findOne).toHaveBeenCalledWith({ phone_number: '1234567890' });
        expect(savedSession).toBeTruthy();
        expect(savedSession.current_step).toBe('selecting_service');
        expect(whatsappService.sendInteractiveList).toHaveBeenCalled();
    });
});
