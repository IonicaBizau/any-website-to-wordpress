import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';

/*
 * Content importer. Reads migration/ only; never contacts Joomla.
 * WordPress REST /wp/v2/menus and /wp/v2/menu-items require a sufficiently
 * privileged Application Password user. A classic menu is created, but no
 * theme location is chosen and the site's front-page setting is untouched.
 * Run --dry-run first. Supported overrides: --force-all-pages-as-pages,
 * --force-all-pages-as-posts, --path=/path (includes ancestor pages).
 * An optional config.wordpressImportStatus of 'draft' or 'publish' controls
 * the status of newly created and previously imported objects (default: draft).
 */

// CLI, canonical identity and state
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const onlyPathFlag = [...args].find(a => a.startsWith('--path='));
const onlyPath = onlyPathFlag ? canonicalPath(onlyPathFlag.slice(7)) : null;
const allPages = args.has('--force-all-pages-as-pages') || config.forceAllPagesAsPages === true;
const allPosts = args.has('--force-all-pages-as-posts') || config.forceAllPagesAsPosts === true;
if (allPages && allPosts) throw new Error('Choose only one post-type override.');
const status = config.wordpressImportStatus || 'draft';
if (!['draft', 'publish'].includes(status)) throw new Error('wordpressImportStatus must be draft or publish.');
const migrationDir = path.resolve(config.migrationDir);
const pagesDir = path.resolve(config.pagesDir);
const assetsDir = path.resolve(config.assetsDir);
const stateFile = path.join(migrationDir, 'wordpress-import.json');
const target = config.wpUrl?.replace(/\/+$/, '') || null;
let origin;
let site;
let assets;
let records;
let selected;
let state;
let wp;
let apiRoot;
const pageByPath = new Map();
const assetByUrl = new Map();
const assetsByPath = new Map();
const errors = [];
const warnings = [];
const unresolvedLinks = new Set();
const failedGalleries = [];
const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };

/**
 *
 * @param input
 */
function canonicalPath(input) {
    let value = input || '/';
    try { value = decodeURI(value); } catch { /* leave invalid escapes intact */ }
    value = value.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    return value.startsWith('/') ? value : `/${value}`;
}
/**
 *
 * @param value
 */
function key(value) { const u = new URL(value); u.hash = ''; return u.href; }
/**
 *
 * @param value
 * @param base
 */
function resolve(value, base) {
    if (!value || /^(?:#|data:|blob:mailto:|tel:|javascript:)/i.test(value.trim())) return null;
    try { const u = new URL(value.trim(), base); return /^https?:$/.test(u.protocol) ? u : null; }
    catch { return null; }
}
/**
 *
 * @param type
 * @param source
 * @param message
 */
function warn(type, source, message) {
    const entry = { type, source, message };
    warnings.push(entry);
    console.warn(`[import] ${type}: ${source}: ${message}`);
}
/**
 *
 * @param type
 * @param source
 * @param endpoint
 * @param error
 */
function fail(type, source, endpoint, error) {
    const entry = { type, source, endpoint, status: error?.response?.status || null,
        error: error?.response?.data?.message || error?.message || String(error),
        code: error?.response?.data?.code || null };
    errors.push(entry); counts.failed++;
    console.error(`[import] ${type}: ${source}: ${entry.status || '-'} ${entry.error}`);
}
/**
 *
 */
function persist() {
    if (dryRun) return Promise.resolve();
    const tmp = `${stateFile}.tmp`;
    return fs.writeJson(tmp, state, { spaces: 2 }).then(() => fs.rename(tmp, stateFile));
}
/**
 *
 */
function snapshot() {
    state.completedAt = new Date().toISOString();
    state.warnings = warnings;
    state.errors = errors;
    state.unresolvedLinks = [...unresolvedLinks];
    state.failedGalleries = failedGalleries;
    state.counts = counts;
    state.dateBehavior = 'No historical date fabricated; WordPress assigns an import-time date.';
}
/**
 *
 * @param u
 */
function assetFor(u) {
    if (!u || u.origin !== origin) return null;
    const exact = assetByUrl.get(key(u));
    if (exact) return exact;
    // Query variants only match when the source pathname uniquely identifies an asset.
    const candidates = assetsByPath.get(u.pathname) || [];
    return candidates.length === 1 ? candidates[0] : null;
}
/**
 *
 * @param value
 * @param base
 */
function mediaFor(value, base) {
    const u = resolve(value, base);
    if (!u) return null;
    const a = assetFor(u);
    return a ? state.media[a.url] || null : null;
}
/**
 *
 * @param value
 */
function cssUrls(value) {
    const out = [];
    for (const m of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
    for (const m of value.matchAll(/@import\s+(?:"([^"]+)"|'([^']+)')/gi)) out.push(m[1] ?? m[2]);
    return out;
}
/**
 *
 * @param value
 * @param base
 */
function mediaUrl(value, base) { return mediaFor(value, base)?.wordpressUrl || value; }
/**
 *
 * @param value
 * @param base
 */
function rewriteSrcset(value, base) {
    return (value || '').split(/,\s*(?=\S)/).map(part => {
        const m = part.trim().match(/^(\S+)(.*)$/s);
        return m ? `${mediaUrl(m[1], base)}${m[2]}` : part;
    }).join(', ');
}
/**
 *
 * @param css
 * @param base
 */
function rewriteCss(css, base) {
    let text = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (whole, a, b, c) => {
        const value = (a ?? b ?? c ?? '').trim();
        const newUrl = mediaFor(value, base)?.wordpressUrl;
        return newUrl ? `url("${newUrl}")` : whole;
    });
    text = text.replace(/@import\s+(?:"([^"]+)"|'([^']+)')/gi, (whole, a, b) => {
        const newUrl = mediaFor(a ?? b, base)?.wordpressUrl;
        return newUrl ? `@import "${newUrl}"` : whole;
    });
    return text;
}

// Validation is complete before the first WordPress write.
/**
 *
 */
async function loadMigration() {
    for (const file of [path.join(migrationDir, 'site.json'), path.join(migrationDir, 'assets.json')]) {
        if (!await fs.pathExists(file)) throw new Error(`Missing migration file: ${file}`);
    }
    if (!await fs.pathExists(pagesDir)) throw new Error(`Missing pages directory: ${pagesDir}`);
    site = await fs.readJson(path.join(migrationDir, 'site.json'));
    assets = await fs.readJson(path.join(migrationDir, 'assets.json'));
    if (!site.sourceOrigin || !Array.isArray(site.pages) || !Array.isArray(assets)) throw new Error('Invalid site/assets manifest.');
    origin = new URL(site.sourceOrigin).origin;
    const homepage = site.pages.find(p => p.path === '/');
    if (!homepage || !site.homepage || site.homepage.path !== '/' || !site.pageMap?.['/']) throw new Error('Homepage missing from site.json, homepage metadata or pageMap.');
    const paths = new Set();
    records = [];
    for (const entry of site.pages) {
        if (typeof entry.path !== 'string' || canonicalPath(entry.path) !== entry.path || paths.has(entry.path)) throw new Error(`Invalid or duplicate page path: ${entry.path}`);
        if (!['page', 'post'].includes(entry.suggestedPostType)) throw new Error(`Invalid suggestedPostType at ${entry.path}`);
        if (entry.path === '/' && entry.suggestedPostType === 'post') throw new Error('Homepage must be a page.');
        if (!entry.file || path.basename(entry.file) !== entry.file || !entry.file.endsWith('.json')) throw new Error(`Invalid page filename at ${entry.path}`);
        const filename = path.join(pagesDir, entry.file);
        if (!await fs.pathExists(filename)) throw new Error(`Missing page file: ${filename}`);
        const record = await fs.readJson(filename);
        if (record.path !== entry.path || record.url !== entry.url || typeof record.originalHtml !== 'string' || !Array.isArray(record.galleries)) throw new Error(`Corrupt page record: ${entry.path}`);
        if (record.galleries.some(g => g.type !== 'sigplus' || !Array.isArray(g.images) || g.images.some(i => !i || typeof i.url !== 'string' || !Array.isArray(i.thumbnailUrls)))) throw new Error(`Corrupt gallery: ${entry.path}`);
        if (entry.path !== '/' && record.parentPath && record.parentPath !== '/' && canonicalPath(record.parentPath) !== record.parentPath) throw new Error(`Invalid parentPath at ${entry.path}`);
        paths.add(entry.path);
        records.push(record);
        pageByPath.set(entry.path, record);
    }
    const assetUrls = new Set();
    for (const asset of assets) {
        if (!asset.url || assetUrls.has(asset.url)) throw new Error(`Invalid or duplicate asset URL: ${asset.url}`);
        assetUrls.add(asset.url);
        const u = new URL(asset.url);
        if (u.origin !== origin) throw new Error(`Asset outside source origin: ${asset.url}`);
        assetByUrl.set(key(asset.url), asset);
        assetsByPath.set(u.pathname, [...(assetsByPath.get(u.pathname) || []), asset]);
        if (!asset.downloaded) continue;
        if (!asset.filename || path.basename(asset.filename) !== asset.filename || asset.localPath !== `assets/${asset.filename}` || !await fs.pathExists(path.join(assetsDir, asset.filename))) throw new Error(`Downloaded asset missing/unsafe: ${asset.url}`);
    }
    const chosen = onlyPath ? pageByPath.get(onlyPath) : null;
    if (onlyPath && !chosen) throw new Error(`--path is not in migration: ${onlyPath}`);
    if (!onlyPath) selected = records;
    else {
        const needed = new Set([onlyPath]);
        let parent = chosen.parentPath;
        while (parent && pageByPath.has(parent) && !needed.has(parent)) { needed.add(parent); parent = pageByPath.get(parent).parentPath; }
        selected = records.filter(r => needed.has(r.path));
    }
    if (allPosts && selected.some(r => r.path === '/')) throw new Error('Cannot force homepage to post; use --force-all-pages-as-pages or omit override.');
    const old = await fs.readJson(stateFile).catch(error => {
        if (error.code === 'ENOENT') return {};
        throw error;
    });
    if (old.sourceUrl && old.sourceUrl !== site.sourceUrl) throw new Error('Existing import state belongs to another source.');
    if (old.wordpressUrl && target && old.wordpressUrl !== target) throw new Error('Existing import state belongs to another WordPress target.');
    state = { version: 1, startedAt: new Date().toISOString(), completedAt: null,
        sourceUrl: site.sourceUrl, wordpressUrl: target, pages: old.pages || {}, posts: old.posts || {},
        media: old.media || {}, menu: old.menu || null, menuItems: old.menuItems || {},
        warnings: [], errors: [], unresolvedLinks: [], failedGalleries: [], counts };
}
/**
 *
 * @param record
 */
function typeFor(record) {
    return record.path === '/' ? 'page' : allPosts ? 'post' : allPages ? 'page' : record.suggestedPostType;
}
/**
 *
 */
function orderedRecords() {
    return [...selected].sort((a, b) => {
        const ta = typeFor(a); const tb = typeFor(b);
        if (ta !== tb) return ta === 'page' ? -1 : 1;
        const depth = s => s.split('/').filter(Boolean).length;
        return depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);
    });
}
/**
 *
 * @param sourcePath
 */
function existingObject(sourcePath) { return state.pages[sourcePath] || state.posts[sourcePath] || null; }

// REST client; Basic auth carries the WP Application Password over HTTPS.
/**
 *
 */
function connect() {
    if (!target || !config.wpUsername || !config.wpAppPassword) throw new Error('Missing WP_URL, WP_USERNAME or WP_APP_PASSWORD in config/.env.');
    const u = new URL(target);
    if (!['https:', 'http:'].includes(u.protocol)) throw new Error('WP_URL must be HTTP(S).');
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('Use HTTPS for Application Password authentication.');
    apiRoot = `${target}/wp-json/wp/v2`;
    wp = axios.create({ baseURL: apiRoot, timeout: 45000, auth: { username: config.wpUsername, password: config.wpAppPassword } });
}
/**
 *
 * @param method
 * @param endpoint
 * @param data
 * @param options
 */
async function request(method, endpoint, data, options = {}) { return (await wp.request({ method, url: endpoint, data, ...options })).data; }
/**
 *
 * @param endpoint
 * @param params
 */
async function listAll(endpoint, params = {}) {
    const found = [];
    for (let page = 1; ; page++) {
        const response = await wp.get(endpoint, { params: { ...params, per_page: 100, page } });
        found.push(...response.data);
        const total = Number(response.headers['x-wp-totalpages'] || 1);
        if (page >= total) break;
    }
    return found;
}
/**
 *
 * @param endpoint
 * @param id
 */
async function verify(endpoint, id) {
    try { return await request('get', `${endpoint}/${id}`, undefined, { params: { context: 'edit' } }); }
    catch (error) { if (error.response?.status === 404) return null; throw error; }
}
/**
 *
 * @param asset
 */
function mediaFilename(asset) {
    const u = new URL(asset.url);
    const decoded = (() => { try { return decodeURIComponent(path.basename(u.pathname)); } catch { return path.basename(u.pathname); } })();
    const original = decoded.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 90) || 'asset';
    const extension = path.extname(original);
    const stem = path.basename(original, extension).slice(0, 70);
    return `${stem}-${crypto.createHash('sha256').update(asset.url).digest('hex').slice(0, 12)}${extension}`;
}
const mimeByExt = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };

// Media: local binary only; persist each successful upload for restartability.
/**
 *
 */
async function importMedia() {
    console.log('Importing media...');
    const downloaded = assets.filter(a => a.downloaded);
    const nonCss = downloaded.filter(a => a.type !== 'css');
    const css = downloaded.filter(a => a.type === 'css');
    for (const asset of [...nonCss, ...css]) {
        const prior = state.media[asset.url];
        try {
            if (prior) {
                const remote = await verify('/media', prior.wordpressMediaId);
                if (remote) {
                    prior.wordpressUrl = remote.source_url;
                    counts.skipped++;
                    continue;
                }
                delete state.media[asset.url];
            }
            let body = await fs.readFile(path.join(assetsDir, asset.filename));
            if (asset.type === 'css') {
                const before = body.toString('utf8');
                const after = rewriteCss(before, asset.url);
                for (const ref of cssUrls(before)) {
                    const referenced = assetFor(resolve(ref, asset.url));
                    if (referenced && !state.media[referenced.url]) warn('css', asset.url, `CSS dependency not imported: ${ref}`);
                }
                body = Buffer.from(after, 'utf8');
            }
            const filename = mediaFilename(asset);
            const contentType = (asset.contentType || '').split(';')[0] || mimeByExt[path.extname(filename).toLowerCase()] || 'application/octet-stream';
            const remote = await request('post', '/media', body, { headers: {
                'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`
            }, maxBodyLength: Infinity });
            state.media[asset.url] = { sourceUrl: asset.url, wordpressMediaId: remote.id, wordpressUrl: remote.source_url, filename };
            await persist();
            counts.created++;
        } catch (error) { fail('media', asset.url, '/media', error); }
    }
    for (const asset of assets.filter(a => !a.downloaded)) warn('media', asset.url, `Not downloaded in crawl: ${asset.error || asset.status || 'unknown'}`);
}

// Objects are created first, so every link can later resolve to a WP permalink.
/**
 *
 */
async function importObjects() {
    console.log('Creating/resolving pages and posts...');
    for (const record of orderedRecords()) {
        const type = typeFor(record);
        const endpoint = type === 'page' ? '/pages' : '/posts';
        const parentPath = record.parentPath;
        // '/' denotes a root-level sibling of the homepage, NOT a child of it.
        // Only a non-root parentPath can provide a WordPress page parent ID.
        const parent = parentPath && parentPath !== '/' && pageByPath.has(parentPath)
            ? existingObject(parentPath)
            : null;
        if (type === 'page' && parentPath && parentPath !== '/' && pageByPath.has(parentPath) && typeFor(pageByPath.get(parentPath)) !== 'page') {
            fail('hierarchy', record.path, endpoint, new Error(`Parent ${parentPath} is a post; cannot parent a page.`)); continue;
        }
        if (type === 'page' && parentPath && parentPath !== '/' && pageByPath.has(parentPath) && !parent) {
            fail('hierarchy', record.path, endpoint, new Error(`Parent ${parentPath} has no WP object.`)); continue;
        }
        if (type === 'post' && parentPath && parentPath !== '/' && pageByPath.has(parentPath)) warn('hierarchy', record.path, 'WordPress posts do not have page parents; source hierarchy retained in report only.');
        const map = type === 'page' ? state.pages : state.posts;
        const wrong = type === 'page' ? state.posts : state.pages;
        if (wrong[record.path]) { fail('type', record.path, endpoint, new Error('Already mapped to other WP object type; refusing duplicate.')); continue; }
        try {
            let remote = map[record.path] && await verify(endpoint, map[record.path].wordpressId);
            if (remote) {
                const changes = {};
                if (type === 'page' && Number(remote.parent || 0) !== Number(parent?.wordpressId || 0)) changes.parent = parent?.wordpressId || 0;
                if (remote.status !== status) changes.status = status;
                if (Object.keys(changes).length) {
                    remote = await request('post', `${endpoint}/${remote.id}`, changes);
                    counts.updated++;
                } else counts.skipped++;
                map[record.path] = { ...map[record.path], wordpressUrl: remote.link,
                    wordpressParentId: type === 'page' ? Number(remote.parent || 0) : null, status: 'existing' };
                await persist();
                continue;
            }
            if (map[record.path]) { warn('object', record.path, 'Previous ID no longer exists; searching by slug before creating.'); delete map[record.path]; }
            const slug = record.path === '/' ? 'migrated-home' : record.slug;
            if (!slug) { fail('object', record.path, endpoint, new Error('Missing slug')); continue; }
            // Never claim an existing object solely by slug: it may belong to someone else.
            const collisions = await listAll(endpoint, { slug, status: 'any', context: 'edit' });
            if (collisions.length) {
                fail('collision', record.path, endpoint, new Error(`Slug ${slug} already exists but has no validated source mapping; manual reconciliation required (IDs: ${collisions.map(x => x.id).join(', ')}).`));
                continue;
            }
            const data = { title: record.title, slug, status };
            if (type === 'page') data.parent = parent?.wordpressId || 0;
            remote = await request('post', endpoint, data);
            map[record.path] = { sourcePath: record.path, sourceUrl: record.url, wordpressId: remote.id,
                wordpressUrl: remote.link, type, status: 'created', parentPath: record.parentPath,
                wordpressParentId: type === 'page' ? data.parent : null };
            await persist();
            counts.created++;
        } catch (error) { fail('object', record.path, endpoint, error); }
    }
}
/**
 *
 * @param value
 */
function esc(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/**
 *
 * @param value
 */
function safeComment(value) { return JSON.stringify(value).replace(/-->/g, '--\\u003e').replace(/</g, '\\u003c'); }
/**
 *
 * @param images
 */
function galleryBlock(images) {
    const inner = images.map(({ image, media }) => {
        const alt = esc(image.alt || '');
        const title = image.title ? ` title="${esc(image.title)}"` : '';
        const caption = image.caption ? `<figcaption class="wp-element-caption">${esc(image.caption)}</figcaption>` : '';
        return `<!-- wp:image ${safeComment({ id: media.wordpressMediaId, sizeSlug: 'full', linkDestination: 'media' })} -->\n<figure class="wp-block-image size-full"><a href="${esc(media.wordpressUrl)}"><img src="${esc(media.wordpressUrl)}" alt="${alt}"${title} class="wp-image-${media.wordpressMediaId}"/></a>${caption}</figure>\n<!-- /wp:image -->`;
    }).join('\n');
    return `<!-- wp:gallery ${safeComment({ linkTo: 'media' })} -->\n<figure class="wp-block-gallery has-nested-images columns-default is-cropped">\n${inner}\n</figure>\n<!-- /wp:gallery -->`;
}
/**
 *
 * @param $
 * @param record
 */
function rewriteGalleryNoscripts($, record) {
    let index = 0;
    $('noscript').each((_, node) => {
        const el = $(node);
        const raw = el.html() || '';
        if (!/sigplus-(?:gallery|image)/i.test(`${el.attr('class') || ''} ${raw}`)) return;
        const gallery = record.galleries[index++];
        if (!gallery) { warn('gallery', record.path, 'Sigplus noscript has no corresponding crawl metadata; retained.'); failedGalleries.push({ path: record.path, index }); return; }
        const images = gallery.images.map(image => ({ image, media: mediaFor(image.url, record.url) }));
        const missing = images.filter(i => !i.media).map(i => i.image.url);
        if (!images.length || missing.length) {
            const message = missing.length ? `Missing full-size WP media: ${missing.join(', ')}` : 'Gallery has no full-size images';
            warn('gallery', record.path, message);
            failedGalleries.push({ path: record.path, index, missing });
            return;
        }
        // Block comments are parsed as comment nodes and remain in the original position.
        el.replaceWith(galleryBlock(images));
    });
    if (index !== record.galleries.length) warn('gallery', record.path, `Detected ${index} galleries in selected content; crawl stored ${record.galleries.length}.`);
}
/**
 *
 * @param value
 * @param base
 * @param record
 */
function rewriteLink(value, base, record) {
    if (!value || /^(?:#|mailto:|tel:|javascript:)/i.test(value.trim())) return value;
    const u = resolve(value, base);
    if (!u || u.origin !== origin) return value;
    const asset = assetFor(u);
    if (asset) return state.media[asset.url]?.wordpressUrl ? `${state.media[asset.url].wordpressUrl}${u.hash}` : value;
    const p = canonicalPath(u.pathname);
    const candidate = pageByPath.get(p);
    if (!candidate) { unresolvedLinks.add(`${record.path}: ${value}`); warn('link', record.path, `Unresolved internal link: ${value}`); return value; }
    const mapped = existingObject(p);
    if (!mapped) { unresolvedLinks.add(`${record.path}: ${value}`); warn('link', record.path, `Migrated page lacks WP object: ${value}`); return value; }
    return `${mapped.wordpressUrl}${u.hash}`;
}
/**
 *
 * @param $
 * @param base
 */
function rewriteContentAssets($, base) {
    $('img, source, video, audio, script, link').each((_, node) => {
        const el = $(node);
        for (const attr of ['src', 'poster', 'data-src', 'data-original', 'data-lazy-src', 'data-image', 'data-url']) {
            const value = el.attr(attr);
            if (value) el.attr(attr, mediaUrl(value, base));
        }
        for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
            const value = el.attr(attr);
            if (value) el.attr(attr, rewriteSrcset(value, base));
        }
        if (node.tagName === 'link' && el.attr('href')) el.attr('href', mediaUrl(el.attr('href'), base));
    });
    $('[style]').each((_, node) => $(node).attr('style', rewriteCss($(node).attr('style'), base)));
    $('style').each((_, node) => $(node).html(rewriteCss($(node).html() || '', base)));
    $('[data-background], [data-bg], [data-background-image], [data-bg-image]').each((_, node) => {
        const el = $(node);
        for (const attr of ['data-background', 'data-bg', 'data-background-image', 'data-bg-image']) {
            const value = el.attr(attr);
            if (value) el.attr(attr, /url\(/i.test(value) ? rewriteCss(value, base) : mediaUrl(value, base));
        }
    });
}
/**
 *
 * @param $
 */
function contentRoot($) {
    // Conservative generic content extraction: prefer explicit content containers.
    // No Joomla theme/chrome, document head, nav, or footer is imported as a page body.
    for (const selector of ['main article', 'article', 'main', '[role="main"]', '#component', '.item-page', '.com-content-article']) {
        const nodes = $(selector);
        if (nodes.length === 1 && nodes.first().text().trim().length) return nodes.first();
    }
    const body = $('body');
    body.find('header, footer, nav, script, style, base, form').remove();
    return body;
}
/**
 *
 * @param record
 */
function convertContent(record) {
    const $ = cheerio.load(record.originalHtml, { decodeEntities: false });
    const root = contentRoot($);
    root.find('base').remove();
    rewriteGalleryNoscripts($, record);
    rewriteContentAssets($, record.url);
    root.find('a[href]').each((_, node) => {
        const el = $(node);
        el.attr('href', rewriteLink(el.attr('href'), record.url, record));
    });
    return root.html() || '';
}
/**
 *
 */
async function updateContent() {
    console.log('Updating content, internal links and galleries...');
    for (const record of orderedRecords()) {
        const mapped = existingObject(record.path);
        if (!mapped) continue;
        const endpoint = mapped.type === 'page' ? '/pages' : '/posts';
        try {
            const html = convertContent(record);
            const hash = crypto.createHash('sha256').update(html).digest('hex');
            if (mapped.contentHash === hash) { counts.skipped++; continue; }
            const remote = await request('post', `${endpoint}/${mapped.wordpressId}`, { content: html, title: record.title });
            mapped.wordpressUrl = remote.link;
            mapped.contentHash = hash;
            mapped.status = 'updated';
            await persist();
            counts.updated++;
        } catch (error) { fail('content', record.path, `${endpoint}/${mapped.wordpressId}`, error); }
    }
}

// Menu entries come from crawl data; parentPath determines menu nesting.
/**
 *
 */
function sourceMenuItems() {
    const items = [];
    const seen = new Set();
    for (const item of site.menus || []) {
        if (!item || !item.title || !item.path) continue;
        const p = canonicalPath(item.path);
        if (seen.has(p)) continue;
        seen.add(p);
        items.push({ title: item.title, path: p, url: item.url });
    }
    return items;
}
/**
 *
 * @param items
 */
function orderedMenuItems(items) {
    const byPath = new Map(items.map((item, position) => [item.path, { ...item, position }]));
    const depths = new Map();
    const visiting = new Set();
    /**
     *
     * @param p
     */
    function depth(p) {
        if (depths.has(p)) return depths.get(p);
        if (visiting.has(p)) throw new Error(`Cycle in menu hierarchy at ${p}`);
        visiting.add(p);
        const parentPath = pageByPath.get(p)?.parentPath;
        const value = parentPath && parentPath !== p && byPath.has(parentPath) ? 1 + depth(parentPath) : 0;
        visiting.delete(p);
        depths.set(p, value);
        return value;
    }
    for (const item of items) depth(item.path);
    return [...byPath.values()].sort((a, b) => depths.get(a.path) - depths.get(b.path) || a.position - b.position);
}
/**
 *
 */
async function importMenu() {
    const sourceItems = sourceMenuItems();
    if (!sourceItems.length) { warn('menu', config.menuName, 'No menu items in site.json.'); return; }
    console.log(`Importing hierarchical menu: ${config.menuName}...`);
    try {
        const menus = await listAll('/menus', { context: 'edit' });
        let menu = menus.find(m => m.name === config.menuName);
        if (!menu) {
            menu = await request('post', '/menus', { name: config.menuName });
            counts.created++;
        }
        state.menu = { name: menu.name, id: menu.id };
        await persist();
        const existing = await listAll('/menu-items', { menus: menu.id, context: 'edit', status: 'any' });
        const remoteById = new Map(existing.map(item => [item.id, item]));
        const sourcePaths = new Set(sourceItems.map(item => item.path));
        const menuIdByPath = new Map();
        const siblingOrder = new Map();
        for (const item of orderedMenuItems(sourceItems)) {
            const mapped = existingObject(item.path);
            if (!mapped) { warn('menu', item.path, 'No imported WordPress object; item not created.'); continue; }
            const sourceParent = pageByPath.get(item.path)?.parentPath;
            let parentId = 0;
            if (sourceParent && sourceParent !== '/' && sourcePaths.has(sourceParent)) {
                parentId = menuIdByPath.get(sourceParent) || 0;
                if (!parentId) warn('menu', item.path, `Parent menu item ${sourceParent} unavailable; leaving at top level.`);
            } else if (sourceParent && sourceParent !== '/' && pageByPath.has(sourceParent)) {
                warn('menu', item.path, `Source parent ${sourceParent} is not in the menu; leaving at top level.`);
            }
            // menu_order is the sibling position; parent must be a MENU ITEM ID, not a page ID.
            const order = (siblingOrder.get(parentId) || 0) + 1;
            siblingOrder.set(parentId, order);
            const payload = { menus: menu.id, title: item.title, status: 'publish', type: 'post_type',
                object: mapped.type, object_id: mapped.wordpressId, parent: parentId, menu_order: order };
            try {
                const priorId = Number(state.menuItems[item.path]);
                const prior = remoteById.get(priorId) || existing.find(x => x.type === 'post_type' && Number(x.object_id) === mapped.wordpressId && x.object === mapped.type);
                if (prior && (prior.type !== 'post_type' || Number(prior.object_id) !== mapped.wordpressId || prior.object !== mapped.type)) {
                    fail('menu-item', item.path, '/menu-items', new Error(`Saved menu item ${prior.id} points at a different WP object; refusing to overwrite it.`));
                    continue;
                }
                const remote = prior ? await request('post', `/menu-items/${prior.id}`, payload) : await request('post', '/menu-items', payload);
                state.menuItems[item.path] = remote.id;
                remoteById.set(remote.id, remote);
                menuIdByPath.set(item.path, remote.id);
                await persist();
                counts[prior ? 'updated' : 'created']++;
                console.log(`[menu] ${item.path} -> item ${remote.id}, parent item ${parentId}, sibling ${order}`);
            } catch (error) { fail('menu-item', item.path, '/menu-items', error); }
        }
    } catch (error) { fail('menu', config.menuName, '/menus', error); }
}

// Dry-run: purely offline; no WP requests and no WP changes.
/**
 *
 */
function dryRunReport() {
    console.log('DRY RUN (offline; no WordPress write or remote existence check).');
    console.log(`Assets downloaded: ${assets.filter(a => a.downloaded).length}; already mapped locally: ${Object.keys(state.media).length}`);
    for (const record of orderedRecords()) {
        const type = typeFor(record);
        const mapped = existingObject(record.path);
        console.log(`${mapped ? 'UPDATE/CHECK' : 'CREATE'} ${type.padEnd(4)} ${record.path} parent=${record.parentPath || '-'} galleries=${record.galleries.length}`);
        const $ = cheerio.load(record.originalHtml);
        $('a[href]').each((_, node) => {
            const value = $(node).attr('href');
            const u = resolve(value, record.url);
            if (!u || u.origin !== origin || assetFor(u)) return;
            const p = canonicalPath(u.pathname);
            if (!pageByPath.has(p)) unresolvedLinks.add(`${record.path}: ${value}`);
        });
        for (const gallery of record.galleries) for (const image of gallery.images) {
            const asset = assetFor(resolve(image.url, record.url));
            if (!asset?.downloaded) failedGalleries.push({ path: record.path, missing: image.url });
        }
    }
    for (const asset of assets.filter(a => !a.downloaded)) warn('media', asset.url, `Not downloaded: ${asset.error || 'unknown'}`);
    console.log(`Unresolved source links: ${unresolvedLinks.size}; missing full-size gallery assets: ${failedGalleries.length}`);
    const menu = sourceMenuItems();
    console.log(`Menu entries: ${menu.length}. Hierarchy from parentPath; source sibling order preserved.`);
    for (const item of orderedMenuItems(menu)) {
        const parent = pageByPath.get(item.path)?.parentPath;
        console.log(`  ${item.path} -> parent ${parent && parent !== '/' && menu.some(x => x.path === parent) ? parent : '(root)'}`);
    }
}
/**
 *
 */
async function validateResults() {
    const home = state.pages['/'];
    if (!home && !onlyPath) warn('homepage', '/', 'Homepage has no WordPress page mapping.');
    for (const record of selected) {
        const mapped = existingObject(record.path);
        if (!mapped) warn('validation', record.path, 'No WordPress object mapping.');
        const expectedParent = record.parentPath && record.parentPath !== '/' && pageByPath.has(record.parentPath)
            ? existingObject(record.parentPath)?.wordpressId || 0 : 0;
        if (mapped?.type === 'page' && mapped.wordpressParentId !== expectedParent) warn('validation', record.path, `Page parent ID ${mapped.wordpressParentId} differs from expected ${expectedParent}.`);
    }
    for (const asset of assets.filter(a => a.downloaded)) if (!state.media[asset.url]) warn('validation', asset.url, 'Downloaded asset not imported.');
    console.log(`Homepage: ${home ? `ID ${home.wordpressId} ${home.wordpressUrl}` : 'NOT IMPORTED'}`);
}
/**
 *
 */
async function main() {
    await loadMigration();
    console.log(`========================================\nWP Migrator - WordPress Import\nSource: ${site.sourceUrl}\nTarget: ${target || '(not configured)'}\nMigration pages: ${selected.length}\nMigration assets: ${assets.length}\n========================================`);
    if (dryRun) return dryRunReport();
    connect();
    try {
        await request('get', '/users/me');
        await importMedia();
        await importObjects();
        await updateContent();
        if (!onlyPath) await importMenu();
        await validateResults();
    } finally {
        snapshot();
        await persist();
        console.log(`========================================\nImport complete\nCreated: ${counts.created}\nUpdated: ${counts.updated}\nSkipped: ${counts.skipped}\nErrors: ${errors.length}\nWarnings: ${warnings.length}\nUnresolved links: ${unresolvedLinks.size}\nFailed galleries: ${failedGalleries.length}`);
    }
    if (errors.length || failedGalleries.length) process.exitCode = 1;
}
main().catch(error => { console.error(`[import] Fatal: ${error.message}`); process.exitCode = 1; });
