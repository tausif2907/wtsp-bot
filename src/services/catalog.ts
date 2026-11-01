import axios from 'axios';

// Reads the online store's catalogue from its Supabase database (the same one the website uses),
// so products added in the website's admin panel show up in the bot automatically.
// Only public data is read, with the publishable key — never put the service_role key here.

export interface SizeStock {
    label: string;
    stock: number;
}

export interface Product {
    id: string;
    slug: string;
    name: string;
    category: string;
    price: number;
    mrp: number | null;
    description: string;
    colour: string;
    fabric: string;
    work: string;
    occasion: string;
    images: string[];
    sizes: SizeStock[];
    is_sold_out: boolean;
    stitch_to_measure: boolean;
    stitch_price: number;
    is_new_arrival: boolean;
    is_bestseller: boolean;
}

export interface Announcement {
    enabled: boolean;
    text: string;
    link: string;
}

const CACHE_MS = 5 * 60 * 1000;
let productCache: { at: number; products: Product[] } | null = null;
let announcementCache: { at: number; value: Announcement | null } | null = null;

export const isCatalogConfigured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);

async function query<T>(pathAndQuery: string): Promise<T> {
    const key = process.env.SUPABASE_ANON_KEY || '';
    const res = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        timeout: 8000
    });
    return res.data as T;
}

// Same defaults as the website (src/lib/products.ts) so older rows never break the bot
const withDefaults = (p: Partial<Product>): Product => ({
    mrp: null,
    description: '',
    colour: '',
    fabric: '',
    work: '',
    occasion: '',
    images: [],
    sizes: [],
    is_sold_out: false,
    stitch_to_measure: false,
    stitch_price: 500,
    is_new_arrival: false,
    is_bestseller: false,
    ...p
} as Product);

/** Published products, newest first. Returns [] when the store database can't be reached. */
export async function getProducts(): Promise<Product[]> {
    if (!isCatalogConfigured()) return [];
    if (productCache && Date.now() - productCache.at < CACHE_MS) return productCache.products;

    try {
        const rows = await query<Partial<Product>[]>('products?select=*&is_published=eq.true&order=created_at.desc');
        const products = rows.map(withDefaults);
        productCache = { at: Date.now(), products };
        return products;
    } catch (error: any) {
        console.error('Could not load products from the store database:', error.response?.data || error.message);
        // Serve the last good list rather than nothing if the database blips
        return productCache?.products || [];
    }
}

export async function getProduct(id: string): Promise<Product | undefined> {
    return (await getProducts()).find(p => p.id === id);
}

/** Categories that have at least one product, in the website's order. */
export async function getCategories(): Promise<{ name: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const p of await getProducts()) counts.set(p.category, (counts.get(p.category) || 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

/** The offer strip shown at the top of the website, if the owner has turned it on. */
export async function getAnnouncement(): Promise<Announcement | null> {
    if (!isCatalogConfigured()) return null;
    if (announcementCache && Date.now() - announcementCache.at < CACHE_MS) return announcementCache.value;

    try {
        const rows = await query<{ value: Announcement }[]>('site_settings?select=value&key=eq.announcement');
        const value = rows[0]?.value?.enabled && rows[0].value.text ? rows[0].value : null;
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

export function clearCatalogCache() {
    productCache = null;
    announcementCache = null;
}
