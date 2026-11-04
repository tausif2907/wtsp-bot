import axios from 'axios';

// Reads the online store's catalogue from its Supabase database (the same one the website uses),
// so products added in the website's admin panel show up in the bot automatically.
// Only public data is read, with the publishable key — never put the service_role key here.

export interface SizeStock {
    label: string;
    stock: number;
}

export type ReturnPolicy = 'exchange' | 'exchange_refund' | 'none';

export interface Product {
    id: string;
    slug: string;
    name: string;
    category: string;
    price: number;
    mrp: number | null;
    description: string;
    size_notes: string;
    colour: string;
    fabric: string;
    work: string;
    occasion: string;
    neckline: string;
    sleeves: string;
    model_info: string;
    images: string[];
    sizes: SizeStock[];
    is_sold_out: boolean;
    stitch_to_measure: boolean;
    stitch_price: number;
    is_new_arrival: boolean;
    is_bestseller: boolean;
    return_policy: ReturnPolicy;
    created_at: string;
}

export interface Rating {
    average: number;
    count: number;
}

export interface Announcement {
    enabled: boolean;
    text: string;
    link: string;
}

export interface CatalogStatus {
    configured: boolean;
    products: number;
    /** When the product list last changed in the bot (ms since epoch, 0 = never loaded). */
    syncedAt: number;
    /** When the bot last asked the store for changes. */
    checkedAt: number;
    error: string;
}

// How often the bot looks for new, edited or removed products. Each check is one tiny request
// (the product count and the latest edit time); the full list is only reloaded when that changes.
export const CHECK_MS = 30 * 1000;
const RATINGS_MS = 10 * 60 * 1000;
const ANNOUNCEMENT_MS = 60 * 1000;

// Same order as PRODUCT_CATEGORIES in the website's src/lib/products.ts
const CATEGORY_ORDER = ['Blouses', 'Lehenga', 'Party Wear', 'Salwar Kameez', 'Western', 'Other'];

// Shopping lists that cut across categories, shown before them
const COLLECTIONS: { key: string; name: string; matches: (p: Product) => boolean }[] = [
    { key: 'col:new', name: '✨ New Arrivals', matches: p => p.is_new_arrival },
    { key: 'col:sale', name: '🏷️ On Sale', matches: p => Boolean(p.mrp && p.mrp > p.price) },
    { key: 'col:best', name: '⭐ Bestsellers', matches: p => p.is_bestseller }
];

let products: Product[] = [];
let fingerprint = '';
let syncedAt = 0;
let checkedAt = 0;
let lastError = '';
let syncing: Promise<void> | null = null;
let ratings = new Map<string, Rating>();
let ratingsAt = 0;
let announcementCache: { at: number; value: Announcement | null } | null = null;
let watcher: ReturnType<typeof setInterval> | null = null;

export const isCatalogConfigured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);

async function request<T>(pathAndQuery: string, headers: Record<string, string> = {}) {
    const key = process.env.SUPABASE_ANON_KEY || '';
    return axios.get<T>(`${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers },
        timeout: 8000
    });
}

// Same defaults as the website (src/lib/products.ts) so older rows never break the bot
const withDefaults = (p: Partial<Product>): Product => ({
    mrp: null,
    description: '',
    size_notes: '',
    colour: '',
    fabric: '',
    work: '',
    occasion: '',
    neckline: '',
    sleeves: '',
    model_info: '',
    images: [],
    sizes: [],
    is_sold_out: false,
    stitch_to_measure: false,
    stitch_price: 500,
    is_new_arrival: false,
    is_bestseller: false,
    return_policy: 'exchange',
    created_at: '',
    ...p
} as Product);

// Every edit (including stock going down after an online order) bumps updated_at, and adding,
// unpublishing or deleting a product changes the count, so together they spot any change.
async function storeFingerprint(): Promise<string> {
    const res = await request<{ updated_at: string }[]>(
        'products?select=updated_at&is_published=eq.true&order=updated_at.desc&limit=1',
        { Prefer: 'count=exact' }
    );
    const total = String(res.headers['content-range'] || '').split('/')[1] || '?';
    return `${total}|${res.data[0]?.updated_at || ''}`;
}

/** Brings the bot's copy of the catalogue up to date with the store. */
export function syncCatalog(force = false): Promise<void> {
    if (!isCatalogConfigured()) return Promise.resolve();
    if (syncing) return syncing;

    syncing = (async () => {
        try {
            const latest = await storeFingerprint();
            if (force || latest !== fingerprint || !syncedAt) {
                const res = await request<Partial<Product>[]>('products?select=*&is_published=eq.true&order=created_at.desc');
                const before = products.length;
                products = res.data.map(withDefaults);
                fingerprint = latest;
                if (syncedAt) console.log(`Online store changed: the bot now has ${products.length} products (was ${before}).`);
                syncedAt = Date.now();
            }
            if (lastError) console.log('Online store reachable again.');
            lastError = '';
        } catch (error: any) {
            const message = error.response?.data?.message || error.code || error.message || 'unknown error';
            // Log each new problem once, not every 30 seconds; keep serving the last good list
            if (message !== lastError) console.error('Could not check the online store for product changes:', message);
            lastError = message;
        }
        checkedAt = Date.now();

        if (force || Date.now() - ratingsAt > RATINGS_MS) await loadRatings();
    })().finally(() => { syncing = null; });

    return syncing;
}

async function loadRatings() {
    try {
        const res = await request<{ product_id: string; average: number; count: number }[]>('product_ratings?select=product_id,average,count');
        ratings = new Map(res.data.map(r => [r.product_id, { average: r.average, count: r.count }]));
    } catch {
        // Reviews are optional (coupons-reviews.sql may not be set up); products still work without them
    }
    ratingsAt = Date.now();
}

/** Keeps the catalogue fresh in the background, so customers never wait for the store. */
export function startCatalogSync() {
    if (watcher || !isCatalogConfigured()) return;
    syncCatalog().then(() => console.log(`Watching the online store for product changes every ${CHECK_MS / 1000} seconds (${products.length} products).`));
    watcher = setInterval(() => { syncCatalog(); }, CHECK_MS);
    watcher.unref();
}

/** Published products, newest first, never more than CHECK_MS out of date. [] when the store can't be reached yet. */
export async function getProducts(): Promise<Product[]> {
    if (!isCatalogConfigured()) return [];
    if (Date.now() - checkedAt >= CHECK_MS) {
        const pending = syncCatalog();
        // While the store is having trouble, answer from the last good list instead of making customers wait
        if (!lastError || !syncedAt) await pending;
    }
    return products;
}

export async function getProduct(id: string): Promise<Product | undefined> {
    return (await getProducts()).find(p => p.id === id);
}

export async function getRating(productId: string): Promise<Rating | undefined> {
    await getProducts();
    return ratings.get(productId);
}

export function getCatalogStatus(): CatalogStatus {
    return { configured: isCatalogConfigured(), products: products.length, syncedAt, checkedAt, error: lastError };
}

export interface Shelf {
    /** List row id: "cat:<category>" or "col:new" / "col:sale" / "col:best" */
    key: string;
    name: string;
    count: number;
}

/** Categories that have at least one product, in the website's order (any new ones after). */
export function categoriesOf(list: Product[]): Shelf[] {
    const counts = new Map<string, number>();
    for (const p of list) counts.set(p.category, (counts.get(p.category) || 0) + 1);
    const rank = (name: string) => (CATEGORY_ORDER.includes(name) ? CATEGORY_ORDER.indexOf(name) : CATEGORY_ORDER.length);
    return [...counts.entries()]
        .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
        .map(([name, count]) => ({ key: `cat:${name}`, name, count }));
}

/** New arrivals, sale and bestseller lists that have at least one product. */
export function collectionsOf(list: Product[]): Shelf[] {
    return COLLECTIONS
        .map(c => ({ key: c.key, name: c.name, count: list.filter(c.matches).length }))
        .filter(c => c.count > 0);
}

export const isShelfKey = (key: string) => key.startsWith('cat:') || COLLECTIONS.some(c => c.key === key);

/** Products on a shelf. Plain category names are accepted too (sessions saved by older versions). */
export function productsOn(list: Product[], key: string): Product[] {
    const collection = COLLECTIONS.find(c => c.key === key);
    if (collection) return list.filter(collection.matches);
    const category = key.startsWith('cat:') ? key.slice(4) : key;
    return list.filter(p => p.category === category);
}

export function shelfName(key: string): string {
    return COLLECTIONS.find(c => c.key === key)?.name || (key.startsWith('cat:') ? key.slice(4) : key);
}

/** The offer strip shown at the top of the website, if the owner has turned it on. */
export async function getAnnouncement(): Promise<Announcement | null> {
    if (!isCatalogConfigured()) return null;
    if (announcementCache && Date.now() - announcementCache.at < ANNOUNCEMENT_MS) return announcementCache.value;

    try {
        const res = await request<{ value: Announcement }[]>('site_settings?select=value&key=eq.announcement');
        const row = res.data[0];
        const value = row?.value?.enabled && row.value.text ? row.value : null;
        announcementCache = { at: Date.now(), value };
        return value;
    } catch {
        return announcementCache?.value || null;
    }
}

export const inStockSizes = (p: Product) => (p.is_sold_out ? [] : p.sizes.filter(s => s.stock > 0).map(s => s.label));

export const isAvailable = (p: Product) => !p.is_sold_out && (p.stitch_to_measure || inStockSizes(p).length > 0);

export const formatPrice = (amount: number) => `₹${amount.toLocaleString('en-IN')}`;

/** Link to the product page on the website, or '' when WEBSITE_URL isn't set. */
export const productUrl = (p: Product) => {
    const site = (process.env.WEBSITE_URL || '').replace(/\/+$/, '');
    return site ? `${site}/shop/${p.slug}` : '';
};

/** Forgets everything loaded, so the next request reads the store afresh. */
export function clearCatalogCache() {
    products = [];
    fingerprint = '';
    syncedAt = 0;
    checkedAt = 0;
    lastError = '';
    ratings = new Map();
    ratingsAt = 0;
    announcementCache = null;
}
