// Rashmi Boutique — store profile.
// Details here match the website (rashmi-tailoring-studio-main/src/lib/store.ts and its pages);
// if you change the address, phone or hours there, change them here too.
// Products and the offer strip are NOT kept here: the bot reads them live from the website's database.

export interface StoreService {
    id: string;          // WhatsApp list row id (must start with "service_")
    title: string;       // Max 24 characters (WhatsApp list limit)
    description: string; // Max 72 characters (WhatsApp list limit)
    price?: number;      // In INR; leave out while prices are quoted after measurement
}

export const STORE = {
    name: 'Rashmi Boutique',
    shortName: 'RB',
    tagline: 'Designer Tailoring in Bistupur since 2002',

    address: 'B/125, Ganjee Line, near Handi Market, Bistupur, Jamshedpur, Jharkhand',
    mapsLink: 'https://maps.app.goo.gl/cGadZBEDu9xFjThB9',
    phone: '+91 82980 34794',
    email: process.env.STORE_EMAIL || '',
    instagram: process.env.STORE_INSTAGRAM || '',

    // Opening hours in India time (24h clock). Used for booking slots and the "we're closed" note.
    openHour: 11,
    closeHour: 22,
    closedWeekday: 2, // 0 = Sunday … 2 = Tuesday
    hoursText: 'Mon – Sun: 11:00 AM – 10:00 PM\nTuesday: Closed',

    invoicePrefix: 'RB',

    // Website theme: gold, brown, cream
    colors: {
        primary: '#816031', // brown  hsl(35 45% 35%)
        accent: '#cc9933',  // gold   hsl(40 60% 50%)
        soft: '#f6f3ee'     // cream  hsl(35 30% 95%)
    }
};

// Same services as the "What We Offer" section of the website
export const SERVICES: StoreService[] = [
    { id: 'service_blouse', title: 'Designer Blouse', description: 'Statement backs, fine embroidery and a fit that holds its shape' },
    { id: 'service_bridal_blouse', title: 'Bridal Blouse Design', description: 'Rich zari, zardozi and embroidery with a neckline made for you' },
    { id: 'service_lehenga', title: 'Lehenga Choli', description: 'Bridal and party lehengas cut to your measurements' },
    { id: 'service_salwar', title: 'Salwar Kameez', description: 'Anarkali, Palazzo, Patiala and more' },
    { id: 'service_skirt', title: 'Custom Skirt', description: 'Western and fusion skirts shaped to your silhouette' },
    { id: 'service_pants', title: 'Custom Pants', description: 'Trousers and palazzos fitted to you, not a size chart' }
];

// Two-hour slots inside opening hours (start hour, 24h clock)
export const TIME_SLOTS = [11, 13, 15, 17, 19].map(start => ({
    start,
    label: `${formatHour(start)} - ${formatHour(start + 2)}`
}));

function formatHour(h: number): string {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${String(hour12).padStart(2, '0')}:00 ${suffix}`;
}

/** Current date and hour in India, whatever time zone the server runs in. */
export function indiaNow(): { date: Date; hour: number; weekday: number } {
    const date = new Date(Date.now() + 5.5 * 60 * 60 * 1000); // read with getUTC* below
    return { date, hour: date.getUTCHours(), weekday: date.getUTCDay() };
}

export function isOpenNow(): boolean {
    const { hour, weekday } = indiaNow();
    return weekday !== STORE.closedWeekday && hour >= STORE.openHour && hour < STORE.closeHour;
}

/** The next `count` days the boutique is open, starting today, as WhatsApp list rows. */
export function upcomingOpenDays(count: number): { id: string; title: string }[] {
    const { date, hour } = indiaNow();
    const lastSlotStart = TIME_SLOTS[TIME_SLOTS.length - 1]!.start;
    const days: { id: string; title: string }[] = [];

    for (let offset = 0; days.length < count && offset < count + 7; offset++) {
        const d = new Date(date.getTime() + offset * 24 * 60 * 60 * 1000);
        if (d.getUTCDay() === STORE.closedWeekday) continue;
        if (offset === 0 && hour >= lastSlotStart) continue; // no slots left today

        const label = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
        const prefix = offset === 0 ? 'Today, ' : offset === 1 ? 'Tomorrow, ' : '';
        days.push({ id: `date_${d.toISOString().slice(0, 10)}`, title: `${prefix}${label}` });
    }
    return days;
}

/** Slots still bookable on the given day (drops slots that have already started today). */
export function slotsFor(dateId: string) {
    const { date, hour } = indiaNow();
    const isToday = dateId === `date_${date.toISOString().slice(0, 10)}`;
    return TIME_SLOTS.filter(slot => !isToday || slot.start > hour);
}

// Contact lines for the "Visit Us" message, invoice and receipt footers
export function storeContactLines(): string[] {
    const lines: string[] = [];
    if (STORE.address) lines.push(`📍 ${STORE.address}`);
    if (STORE.mapsLink) lines.push(`🗺️ ${STORE.mapsLink}`);
    if (STORE.phone) lines.push(`📞 ${STORE.phone}`);
    if (STORE.email) lines.push(`✉️ ${STORE.email}`);
    if (STORE.instagram) lines.push(`📸 ${STORE.instagram}`);
    if (process.env.WEBSITE_URL) lines.push(`🛍️ ${process.env.WEBSITE_URL}`);
    return lines;
}
