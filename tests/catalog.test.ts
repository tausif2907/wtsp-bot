import axios from 'axios';
import {
    getProducts, getRating, syncCatalog, clearCatalogCache, getCatalogStatus,
    categoriesOf, collectionsOf, productsOn, CHECK_MS, Product
} from '../src/services/catalog';

jest.mock('axios');
const get = axios.get as jest.Mock;

// A stand-in for the website's Supabase database
let store: any[];
let requests: string[];
let storeDown: boolean;
let now: number;

const row = (id: string, fields: Record<string, any> = {}) => ({
    id, slug: id, name: `Design ${id}`, category: 'Blouses', price: 1000, images: [], sizes: [],
    is_published: true, created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', ...fields
});

beforeEach(() => {
    process.env.SUPABASE_URL = 'https://shop.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'sb_publishable_test';
    clearCatalogCache();
    store = [row('a')];
    requests = [];
    storeDown = false;
    now = Date.parse('2026-11-04T10:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(console, 'log').mockImplementation(() => { });
    jest.spyOn(console, 'error').mockImplementation(() => { });

    get.mockImplementation(async (url: string) => {
        requests.push(url);
        if (storeDown) throw Object.assign(new Error('getaddrinfo ENOTFOUND shop.supabase.co'), { code: 'ENOTFOUND' });
        const published = store.filter(p => p.is_published);
        if (url.includes('limit=1')) {
            const latest = [...published].sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0];
            return { data: latest ? [{ updated_at: latest.updated_at }] : [], headers: { 'content-range': `0-0/${published.length}` } };
        }
        if (url.includes('product_ratings')) return { data: [{ product_id: 'a', average: 4.5, count: 2 }], headers: {} };
        return { data: published, headers: {} };
    });
});

afterEach(() => jest.restoreAllMocks());

const fullLoads = () => requests.filter(u => u.includes('select=*')).length;

describe('Keeping the bot in step with the online store', () => {
    it('loads the published products once and answers from that copy for 30 seconds', async () => {
        expect((await getProducts()).map(p => p.id)).toEqual(['a']);
        expect(requests.find(u => u.includes('select=*'))).toContain('is_published=eq.true');

        const before = requests.length;
        now += CHECK_MS - 1000;
        await getProducts();
        expect(requests.length).toBe(before);
    });

    it('picks up a product added on the website within 30 seconds', async () => {
        await getProducts();
        store.unshift(row('b', { name: 'Ivory Chikankari Blouse', created_at: '2026-11-04T10:00:10Z', updated_at: '2026-11-04T10:00:10Z' }));

        now += CHECK_MS;
        const products = await getProducts();
        expect(products.map(p => p.name)).toContain('Ivory Chikankari Blouse');
        expect(fullLoads()).toBe(2);
    });

    it('only sends the small change check when nothing changed', async () => {
        await getProducts();
        requests = [];

        now += CHECK_MS;
        await getProducts();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain('limit=1');
    });

    it('notices price edits, stock changes, unpublished and deleted products', async () => {
        store.push(row('b'));
        await getProducts();

        store[0] = { ...store[0], price: 850, sizes: [{ label: 'M', stock: 0 }], updated_at: '2026-11-04T10:01:00Z' };
        now += CHECK_MS;
        expect((await getProducts()).find(p => p.id === 'a')?.price).toBe(850);

        store[1] = { ...store[1], is_published: false, updated_at: '2026-11-04T10:02:00Z' };
        now += CHECK_MS;
        expect((await getProducts()).map(p => p.id)).toEqual(['a']);

        store = [];
        now += CHECK_MS;
        expect(await getProducts()).toEqual([]);
    });

    it('keeps showing the last list, and says why, when the store cannot be reached', async () => {
        await getProducts();
        storeDown = true;

        now += CHECK_MS;
        expect((await getProducts()).map(p => p.id)).toEqual(['a']);
        await syncCatalog();
        expect(getCatalogStatus()).toMatchObject({ configured: true, products: 1, error: 'ENOTFOUND' });

        storeDown = false;
        now += CHECK_MS;
        await syncCatalog();
        expect(getCatalogStatus().error).toBe('');
    });

    it('reloads everything on "Refresh from website", even when nothing changed', async () => {
        await getProducts();
        await syncCatalog(true);
        expect(fullLoads()).toBe(2);
    });

    it('reads ratings from approved reviews', async () => {
        expect(await getRating('a')).toEqual({ average: 4.5, count: 2 });
        expect(await getRating('missing')).toBeUndefined();
    });

    it('fills in fields that older products do not have', async () => {
        const [p] = await getProducts();
        expect(p).toMatchObject({ mrp: null, neckline: '', return_policy: 'exchange', stitch_to_measure: false, stitch_price: 500 });
    });
});

describe('Shelves', () => {
    const p = (id: string, fields: Partial<Product>) => ({ ...row(id), mrp: null, is_new_arrival: false, is_bestseller: false, ...fields }) as unknown as Product;

    it('lists categories in the website order, with new ones at the end', () => {
        const list = ['Western', 'Kids', 'Blouses', 'Other', 'Lehenga', 'Blouses'].map((category, i) => p(String(i), { category }));
        expect(categoriesOf(list).map(c => `${c.name}:${c.count}`)).toEqual(['Blouses:2', 'Lehenga:1', 'Western:1', 'Other:1', 'Kids:1']);
    });

    it('builds new arrival, sale and bestseller lists only when they have products', () => {
        const list = [p('1', { is_new_arrival: true }), p('2', { mrp: 1500 }), p('3', {})];
        expect(collectionsOf(list).map(c => c.key)).toEqual(['col:new', 'col:sale']);
        expect(productsOn(list, 'col:sale').map(x => x.id)).toEqual(['2']);
        expect(productsOn(list, 'cat:Blouses')).toHaveLength(3);
        expect(productsOn(list, 'Blouses')).toHaveLength(3); // category name saved by an older version
    });
});
