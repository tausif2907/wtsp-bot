import { Session } from '../models/Session';
import { Customer } from '../models/Customer';
import { Order } from '../models/Order';
import { whatsappService } from './whatsapp';
import crypto from 'crypto';

export class FlowController {

    async handleMessage(message: any) {
        const from = message.from;
        const msgType = message.type;

        // Find or create session
        let session = await Session.findOne({ phone_number: from });
        if (!session) {
            session = new Session({ phone_number: from, current_step: 'start' });
            await session.save();
        }

        try {
            switch (session.current_step) {
                case 'start':
                    await this.handleStart(from, session, message);
                    break;
                case 'selecting_service':
                    await this.handleServiceSelection(from, session, message);
                    break;
                case 'selecting_date':
                    await this.handleDateSelection(from, session, message);
                    break;
                case 'selecting_time':
                    await this.handleTimeSelection(from, session, message);
                    break;
                case 'entering_name':
                    await this.handleNameEntry(from, session, message);
                    break;
                case 'sharing_location':
                    await this.handleLocationEntry(from, session, message);
                    break;
                default:
                    await whatsappService.sendText(from, 'An error occurred. Please type "Hi" to restart.');
                    session.current_step = 'start';
                    await session.save();
            }
        } catch (error) {
            console.error('Error in flow controller:', error);
            await whatsappService.sendText(from, 'Sorry, something went wrong. Let us start over. Reply "Hi".');
            session.current_step = 'start';
            await session.save();
        }
    }

    private async handleStart(from: string, session: any, message: any) {
        // Send Welcome Message + Services
        await whatsappService.sendInteractiveList(from, 'Welcome to our Tailoring Service! Please select the service you need:', {
            buttonText: 'View Services',
            title: 'Available Services',
            rows: [
                { id: 'service_blouse', title: 'Blouse Stitching' },
                { id: 'service_kurti', title: 'Kurti Stitching' },
                { id: 'service_suit', title: 'Suit Stitching' },
                { id: 'service_alteration', title: 'Alteration' },
                { id: 'service_express', title: 'Express Stitching', description: 'Available 9AM - 8PM' }
            ]
        });

        session.current_step = 'selecting_service';
        await session.save();
    }

    private async handleServiceSelection(from: string, session: any, message: any) {
        if (message.type !== 'interactive' || message.interactive.type !== 'list_reply') {
            await whatsappService.sendText(from, 'Please select a service from the menu provided.');
            return;
        }

        const selectedId = message.interactive.list_reply.id;
        const title = message.interactive.list_reply.title;

        // Express stitching time check
        if (selectedId === 'service_express') {
            const currentHour = new Date().getHours();
            if (currentHour < 9 || currentHour >= 20) {
                await whatsappService.sendText(from, 'Express stitching booking is available only between 9:00 AM and 8:00 PM. Please choose another service or book tomorrow.');
                // We keep them in selecting_service so they can re-select from the previous list.
                return;
            }
        }

        session.selected_service = title;
        session.current_step = 'selecting_date';
        await session.save();

        await whatsappService.sendInteractiveList(from, `You selected ${title}. When would you like to book?`, {
            buttonText: 'View Dates',
            rows: [
                { id: 'date_today', title: 'Today' },
                { id: 'date_tomorrow', title: 'Tomorrow' },
                { id: 'date_other', title: 'Select another date' }
            ]
        });
    }

    private async handleDateSelection(from: string, session: any, message: any) {
        if (message.type !== 'interactive' || message.interactive.type !== 'list_reply') {
            await whatsappService.sendText(from, 'Please select a date from the menu provided.');
            return;
        }

        session.selected_date = message.interactive.list_reply.title;
        session.current_step = 'selecting_time';
        await session.save();

        await whatsappService.sendInteractiveList(from, 'Please select a time slot:', {
            buttonText: 'View Times',
            rows: [
                { id: 'time_10am', title: '10:00 AM' },
                { id: 'time_12pm', title: '12:00 PM' },
                { id: 'time_2pm', title: '2:00 PM' },
                { id: 'time_4pm', title: '4:00 PM' },
                { id: 'time_6pm', title: '6:00 PM' }
            ]
        });
    }

    private async handleTimeSelection(from: string, session: any, message: any) {
        if (message.type !== 'interactive' || message.interactive.type !== 'list_reply') {
            await whatsappService.sendText(from, 'Please select a time slot from the menu provided.');
            return;
        }

        session.selected_time = message.interactive.list_reply.title;
        session.current_step = 'entering_name';
        await session.save();

        await whatsappService.sendText(from, 'Great! Please enter your full name:');
    }

    private async handleNameEntry(from: string, session: any, message: any) {
        if (message.type !== 'text') {
            await whatsappService.sendText(from, 'Please type your name using text.');
            return;
        }

        session.name = message.text.body;
        session.current_step = 'sharing_location';
        await session.save();

        await whatsappService.sendText(from, 'Please share your location so our tailor can reach you.\nTap the attachment icon (📎) and select Location to share your current location.');
    }

    private async handleLocationEntry(from: string, session: any, message: any) {
        if (message.type !== 'location') {
            await whatsappService.sendText(from, 'Please share your location using the attachment icon (📎) -> Location.');
            return;
        }

        const lat = message.location.latitude;
        const lng = message.location.longitude;

        // 1. Upsert Customer
        await Customer.findOneAndUpdate(
            { phone_number: from },
            { name: session.name, location_lat: lat, location_lng: lng },
            { upsert: true, new: true }
        );

        // 2. Create Order
        const orderId = crypto.randomUUID();
        await Order.create({
            order_id: orderId,
            customer_phone: from,
            service: session.selected_service,
            booking_date: session.selected_date,
            booking_time: session.selected_time,
            latitude: lat,
            longitude: lng,
            status: 'confirmed'
        });

        // 3. Send Confirmation to Customer
        await whatsappService.sendText(from, `✅ Booking Confirmed!\n\nService: ${session.selected_service}\nName: ${session.name}\nDate: ${session.selected_date}\nTime: ${session.selected_time}\nYour location has been received.`);

        // 4. Send Notification to Owner
        const ownerPhone = process.env.OWNER_PHONE_NUMBER;
        if (ownerPhone) {
            const googleMapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
            const ownerMsg = `*NEW APPOINTMENT*\n\nCustomer: ${session.name}\nPhone: +${from}\nService: ${session.selected_service}\nDate: ${session.selected_date}\nTime: ${session.selected_time}\n\nCustomer Location:\n${googleMapsUrl}`;
            await whatsappService.sendText(ownerPhone, ownerMsg);
        }

        // 5. Reset Session (or delete it)
        await Session.deleteOne({ phone_number: from });
    }
}

export const flowController = new FlowController();
