import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import config from '../config.js';

// Configuration and URL identity
if (!config.sourceUrl) throw new Error('SOURCE_URL is required');
const source = new URL(config.sourceUrl);
const origin = source.origin;
const rootUrl = `${origin}/`;
const migrationDir = path.resolve(config.migrationDir);
const pagesDir = path.resolve(config.pagesDir);
const assetsDir = path.resolve(config.assetsDir);
const pageLimit = pLimit(Math.max(1, Number(config.concurrency) || 5));
const resourceLimit = pLimit(Math.max(1, Number(config.resourceConcurrency) || 8));
const delay = Math.max(0, Number(config.requestDelay) || 0);
const nonPages = new Set('.jpg .jpeg .png .gif .webp .svg .ico .bmp .avif .css .js .mjs .json .xml .txt .pdf .doc .docx .xls .xlsx .ppt .pptx .csv .zip .rar .7z .tar .gz .mp3 .wav .ogg .m4a .aac .mp4 .webm .mov .avi .m4v .woff .woff2 .ttf .otf .eot'.split(' '));
const http = axios.create({ timeout: 30000, maxRedirects: 8, validateStatus: () => true, headers: { 'User-Agent': 'WP-Migrator/1.0 (site archival)', Accept: '*/*' } });
const pages = new Map();
const resources = new Map();
const errors = [];
const menuMap = new Map();
const seenPages = new Set();
const pageQueue = [];
const resourceTasks = new Set();
let lastRequest = 0;

/**
 *
 * @param pathname
 */
function canonicalPath(pathname) {
    let value = pathname || '/';
    try { value = decodeURI(value); } catch { /* preserve malformed escapes */ }
    value = value.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    return value.startsWith('/') ? value : `/${value}`;
}
/**
 *
 * @param p
 */
function canonicalPageUrl(p) { return new URL(p === '/' ? '/' : p, origin).href; }
/**
 *
 * @param value
 * @param base
 */
function resolveUrl(value, base = rootUrl) {
    if (!value || /^(?:#|data:|blob:|javascript:|mailto:|tel:)/i.test(value.trim())) return null;
    try {
        const u = new URL(value.trim(), base);
        if (!/^https?:$/.test(u.protocol) || u.origin !== origin) return null;
        u.hash = '';
        return u;
    } catch { return null; }
}
/**
 *
 * @param u
 */
function resourceKey(u) {
    const url = new URL(u);
    url.hash = '';
    return url.href;
}
/**
 *
 * @param u
 */
function ext(u) { return path.extname(new URL(u).pathname).toLowerCase(); }
/**
 *
 * @param u
 */
function isPage(u) { return !nonPages.has(ext(u)); }
/**
 *
 * @param u
 */
function pagePath(u) { return canonicalPath(u.pathname); }
/**
 *
 * @param url
 */
function filenameForPage(url) { return `${Buffer.from(url).toString('base64url')}.json`; }
/**
 *
 * @param url
 */
function resourceName(url) {
    const u = new URL(url);
    const base = path.basename(u.pathname) || 'resource';
    const safe = base.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 100) || 'resource';
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    return `${hash}-${safe}`;
}
/**
 *
 * @param u
 * @param contentType
 */
function kind(u, contentType = '') {
    const extension = ext(u);
    if (extension === '.css' || /text\/css/i.test(contentType)) return 'css';
    if ('.jpg .jpeg .png .gif .webp .svg .ico .bmp .avif'.split(' ').includes(extension) || /^image\//i.test(contentType)) return 'image';
    if ('.woff .woff2 .ttf .otf .eot'.split(' ').includes(extension) || /^font\//i.test(contentType)) return 'font';
    if ('.js .mjs'.split(' ').includes(extension)) return 'script';
    if (/^(audio|video)\//i.test(contentType) || '.mp3 .wav .ogg .m4a .aac .mp4 .webm .mov .avi .m4v'.split(' ').includes(extension)) return 'media';
    return 'file';
}
/**
 *
 */
async function throttle() {
    if (!delay) return;
    const wait = Math.max(0, lastRequest + delay - Date.now());
    lastRequest = Date.now() + wait;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
}
/**
 *
 * @param url
 */
async function get(url) {
    await throttle();
    return http.get(url, { responseType: 'arraybuffer', maxContentLength: 100 * 1024 * 1024 });
}
/**
 *
 * @param type
 * @param url
 * @param error
 */
function logError(type, url, error) {
    errors.push({ type, url, error: String(error?.message || error) });
    console.warn(`[crawl] ${type}: ${url}: ${error?.message || error}`);
}

// Resource discovery and recursive CSS
/**
 *
 * @param css
 */
function cssUrls(css) {
    const found = [];
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    for (const match of css.matchAll(re)) found.push((match[1] ?? match[2] ?? match[3] ?? '').trim());
    const imports = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;
    for (const match of css.matchAll(imports)) found.push(match[1] ?? match[2]);
    return found;
}
/**
 *
 * @param value
 * @param base
 * @param sourceLabel
 */
function registerResource(value, base, sourceLabel) {
    const u = resolveUrl(value, base);
    if (!u) return null;
    const url = resourceKey(u);
    if (resources.has(url)) return url;
    const filename = resourceName(url);
    const item = { url, type: kind(url), filename, localPath: `assets/${filename}`, downloaded: false, status: null, contentType: null, size: 0, error: null, source: sourceLabel };
    resources.set(url, item);
    const task = resourceLimit(async () => {
        try {
            const response = await get(url);
            item.status = response.status;
            item.contentType = response.headers['content-type'] || null;
            item.type = kind(url, item.contentType || '');
            if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
            if (/text\/html/i.test(item.contentType || '')) throw new Error('Unexpected HTML resource');
            const data = Buffer.from(response.data);
            item.size = data.length;
            await fs.writeFile(path.join(assetsDir, filename), data);
            item.downloaded = true;
            if (item.type === 'css') for (const child of cssUrls(data.toString('utf8'))) registerResource(child, url, url);
        } catch (error) { item.error = String(error.message || error); logError('resource', url, error); }
    });
    resourceTasks.add(task);
    task.finally(() => resourceTasks.delete(task));
    return url;
}
/**
 *
 * @param value
 */
function srcsetUrls(value) {
    // Common srcset grammar: URLs separated by commas; data URLs are intentionally ignored.
    return (value || '').split(/,\s*(?=\S)/).map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
}
/**
 *
 * @param value
 * @param base
 * @param label
 */
function addSrcset(value, base, label) { for (const u of srcsetUrls(value)) registerResource(u, base, label); }
/**
 *
 * @param raw
 * @param base
 */
function parseGallery(raw, base) {
    const gallery = cheerio.load(raw, { decodeEntities: false });
    const images = [];
    gallery('a.sigplus-image').each((_, a) => {
        const full = resolveUrl(gallery(a).attr('href'), base);
        if (!full) return;
        const url = registerResource(full.href, base, 'sigplus:full');
        const thumbs = new Set();
        gallery(a).find('img, source').each((__, node) => {
            const element = gallery(node);
            for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
                const u = registerResource(element.attr(attr), base, 'sigplus:thumbnail');
                if (u) thumbs.add(u);
            }
            for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
                for (const part of srcsetUrls(element.attr(attr))) {
                    const u = registerResource(part, base, 'sigplus:thumbnail');
                    if (u) thumbs.add(u);
                }
            }
        });
        const img = gallery(a).find('img').first();
        images.push({ url, thumbnailUrls: [...thumbs], alt: img.attr('alt') || '', title: gallery(a).attr('title') || null });
    });
    return images;
}
/**
 *
 * @param $
 * @param base
 * @param galleries
 */
function collectResources($, base, galleries) {
    $('img, source, video, audio, script, link').each((_, node) => {
        const el = $(node);
        const tag = node.tagName?.toLowerCase();
        if (tag === 'link' && !/^(?:stylesheet|icon|shortcut icon|apple-touch-icon|preload|modulepreload)$/i.test(el.attr('rel') || '')) return;
        for (const attr of ['src', 'href', 'poster', 'data-src', 'data-original', 'data-lazy-src', 'data-image', 'data-url']) {
            if (attr === 'href' && tag !== 'link') continue;
            registerResource(el.attr(attr), base, base);
        }
        for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) addSrcset(el.attr(attr), base, base);
    });
    $('a[download], a[href]').each((_, node) => {
        const el = $(node);
        const u = resolveUrl(el.attr('href'), base);
        if (u && (el.is('[download]') || !isPage(u))) registerResource(u.href, base, base);
    });
    $('[style]').each((_, node) => { for (const u of cssUrls($(node).attr('style') || '')) registerResource(u, base, base); });
    $('style').each((_, node) => { for (const u of cssUrls($(node).html() || '')) registerResource(u, base, base); });
    $('[data-background], [data-bg], [data-background-image], [data-bg-image]').each((_, node) => {
        for (const attr of ['data-background', 'data-bg', 'data-background-image', 'data-bg-image']) {
            const value = $(node).attr(attr);
            if (value) for (const u of /url\(/i.test(value) ? cssUrls(value) : [value]) registerResource(u, base, base);
        }
    });
    $('noscript').each((_, node) => {
        const el = $(node);
        const raw = el.html() || '';
        if (!/sigplus-(?:gallery|image)/i.test(`${el.attr('class') || ''} ${raw}`)) return;
        const images = parseGallery(raw, base);
        if (images.length) galleries.push({ type: 'sigplus', images });
    });
}

// Page queue, extraction, and hierarchy
/**
 *
 * @param value
 * @param base
 */
function enqueue(value, base = rootUrl) {
    const u = resolveUrl(value, base);
    if (!u || !isPage(u)) return;
    const p = pagePath(u);
    if (!seenPages.has(p)) { seenPages.add(p); pageQueue.push({ path: p, url: canonicalPageUrl(p) }); }
}
/**
 *
 * @param $
 * @param base
 */
function extractMenus($, base) {
    const result = [];
    $('nav, .mod-menu, ul.menu, .main-menu, .navbar-nav').each((_, node) => {
        const items = [];
        $(node).find('a[href]').each((__, anchor) => {
            const u = resolveUrl($(anchor).attr('href'), base);
            if (!u || !isPage(u)) return;
            const title = $(anchor).text().replace(/\s+/g, ' ').trim();
            if (title) items.push({ title, url: canonicalPageUrl(pagePath(u)), path: pagePath(u) });
        });
        if (items.length) result.push({ items });
    });
    return result;
}
/**
 *
 * @param candidate
 */
async function crawlPage(candidate) {
    try {
        const response = await get(candidate.url);
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
        if (!/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] || '')) throw new Error(`Non-HTML: ${response.headers['content-type'] || 'unknown'}`);
        const html = Buffer.from(response.data).toString('utf8');
        const effective = resolveUrl(response.request?.res?.responseUrl || candidate.url);
        const base = effective?.href || candidate.url;
        const $ = cheerio.load(html, { decodeEntities: false });
        const galleries = [];
        collectResources($, base, galleries);
        const internalLinks = new Set();
        $('a[href]').each((_, a) => {
            const u = resolveUrl($(a).attr('href'), base);
            if (!u) return;
            if (isPage(u)) { const p = pagePath(u); internalLinks.add(p); enqueue(u.href); }
        });
        const menus = extractMenus($, base);
        for (const menu of menus) for (const item of menu.items) menuMap.set(`${item.title}\0${item.path}`, item);
        const p = candidate.path;
        const segments = p.split('/').filter(Boolean);
        const url = canonicalPageUrl(p);
        const page = {
            url, path: p, slug: segments.at(-1) || '', parentPath: p === '/' ? null : segments.length === 1 ? '/' : `/${segments.slice(0, -1).join('/')}`,
            title: $('title').first().text().trim() || $('h1').first().text().trim() || p,
            suggestedPostType: (config.postPathPrefixes || []).some(prefix => p === canonicalPath(prefix) || p.startsWith(`${canonicalPath(prefix)}/`)) ? 'post' : 'page',
            originalHtml: html, resources: [...resources.values()].filter(r => r.source === base).map(r => r.url),
            galleries, internalLinks: [...internalLinks], menus, crawledAt: new Date().toISOString()
        };
        pages.set(p, page);
        await fs.writeJson(path.join(pagesDir, filenameForPage(url)), page, { spaces: 2 });
    } catch (error) { logError('page', candidate.url, error); }
}

// Sitemap discovery: indexes, gzip, robots and URL sets
/**
 *
 */
async function discoverSitemaps() {
    const sitemapQueue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`, `${origin}/sitemap.xml.gz`];
    try {
        const response = await get(`${origin}/robots.txt`);
        if (response.status >= 200 && response.status < 300) {
            for (const line of Buffer.from(response.data).toString('utf8').split(/\r?\n/)) {
                const match = line.match(/^\s*Sitemap:\s*(\S+)/i);
                if (match) sitemapQueue.push(match[1]);
            }
        }
    } catch (error) { logError('robots', `${origin}/robots.txt`, error); }
    const visited = new Set();
    while (sitemapQueue.length) {
        const candidate = sitemapQueue.shift();
        const u = resolveUrl(candidate, rootUrl);
        if (!u || visited.has(u.href)) continue;
        visited.add(u.href);
        try {
            const response = await get(u.href);
            if (response.status < 200 || response.status >= 300) continue;
            let buffer = Buffer.from(response.data);
            if (u.pathname.endsWith('.gz') || buffer.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) buffer = zlib.gunzipSync(buffer);
            const xml = buffer.toString('utf8');
            if (!/<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(xml)) continue;
            const $ = cheerio.load(xml, { xmlMode: true });
            $('sitemap > loc, sitemapindex > sitemap > loc').each((_, node) => sitemapQueue.push($(node).text().trim()));
            $('url > loc, urlset > url > loc').each((_, node) => enqueue($(node).text().trim()));
        } catch (error) { logError('sitemap', u.href, error); }
    }
}

// Fresh crawl and deterministic manifests
/**
 *
 */
async function main() {
    console.log('========================================\n WP Migrator - Fresh Crawl\n========================================');
    console.log(`Source: ${rootUrl}`);
    await fs.emptyDir(migrationDir);
    await fs.ensureDir(pagesDir);
    await fs.ensureDir(assetsDir);
    enqueue(rootUrl);
    await discoverSitemaps();
    console.log(`Sitemap pages discovered: ${Math.max(0, seenPages.size - 1)}`);
    while (pageQueue.length) {
        const batch = pageQueue.splice(0, Math.max(1, Number(config.concurrency) || 5));
        await Promise.all(batch.map(candidate => pageLimit(() => crawlPage(candidate))));
    }
    while (resourceTasks.size) await Promise.allSettled([...resourceTasks]);
    const entries = [...pages.values()].sort((a, b) => a.path.localeCompare(b.path));
    const compact = entries.map(({ url, path: pagePathValue, slug, parentPath, title, suggestedPostType }) => ({
        url, path: pagePathValue, slug, parentPath, title, suggestedPostType, file: filenameForPage(url)
    }));
    const homepage = compact.find(p => p.path === '/') || null;
    const assets = [...resources.values()].sort((a, b) => a.url.localeCompare(b.url));
    const manifest = {
        version: 1, sourceUrl: rootUrl, sourceOrigin: origin, crawledAt: new Date().toISOString(),
        pageCount: compact.length, resourceCount: assets.length, downloadedResourceCount: assets.filter(a => a.downloaded).length,
        pageTypeRules: { postPathPrefixes: config.postPathPrefixes || [] }, homepage,
        pages: compact, pageMap: Object.fromEntries(compact.map(p => [p.path, p])),
        menus: [...menuMap.values()], crawlErrors: errors
    };
    await fs.writeJson(path.join(migrationDir, 'assets.json'), assets, { spaces: 2 });
    await fs.writeJson(path.join(migrationDir, 'site.json'), manifest, { spaces: 2 });
    console.log('========================================\n Crawl complete\n========================================');
    console.log(`Pages:       ${pages.size}\nHomepage:    ${pages.has('/') ? 'YES' : 'NO'}\nResources:   ${assets.length}\nDownloaded:  ${manifest.downloadedResourceCount}\nErrors:      ${errors.length}`);
    if (homepage) console.log(`Homepage file: ${homepage.file}`);
    else { console.error('ERROR: Homepage was NOT crawled.'); process.exitCode = 1; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
