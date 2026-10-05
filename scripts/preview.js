import 'dotenv/config';
import express from 'express';
import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'node:path';
import config from '../config.js';

// Manifest and shared canonical path convention: root '/', no other trailing slash.
const migrationDir = path.resolve(config.migrationDir);
const assetsDir = path.resolve(config.assetsDir);
const site = await fs.readJson(path.join(migrationDir, 'site.json'));
const assets = await fs.readJson(path.join(migrationDir, 'assets.json'));
const origin = site.sourceOrigin || new URL(site.sourceUrl).origin;
const port = Number(process.env.PREVIEW_PORT || 3000);
const app = express();
const pageByPath = new Map((site.pages || []).map(page => [canonicalPath(page.path), page]));
const pageByUrl = new Map((site.pages || []).map(page => [canonicalUrl(page.url), page]));
const assetByUrl = new Map(assets.filter(a => a.downloaded).map(a => [canonicalUrl(a.url), a]));
const missing = new Set();

/**
 *
 * @param pathname
 */
function canonicalPath(pathname) {
    let value = pathname || '/';
    try { value = decodeURI(value); } catch { /* keep malformed escapes */ }
    value = value.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    return value.startsWith('/') ? value : `/${value}`;
}
/**
 *
 * @param value
 */
function canonicalUrl(value) { const u = new URL(value); u.hash = ''; return u.href; }
/**
 *
 * @param value
 * @param base
 */
function resolve(value, base) {
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
 * @param value
 * @param base
 */
function localAsset(value, base) {
    const u = resolve(value, base);
    if (!u) return null;
    const item = assetByUrl.get(u.href);
    return item ? `/__assets/${encodeURIComponent(item.filename)}` : null;
}
/**
 *
 * @param value
 * @param base
 */
function rewriteAsset(value, base) { return localAsset(value, base) || value; }
/**
 *
 * @param value
 * @param base
 */
function rewriteSrcset(value, base) {
    return (value || '').split(/,\s*(?=\S)/).map(part => {
        const match = part.trim().match(/^(\S+)(.*)$/s);
        return match ? `${rewriteAsset(match[1], base)}${match[2]}` : part;
    }).join(', ');
}
/**
 *
 * @param css
 * @param base
 */
function rewriteCss(css, base) {
    let output = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (whole, d, s, plain) => {
        const raw = (d ?? s ?? plain ?? '').trim();
        const local = localAsset(raw, base);
        return local ? `url("${local}")` : whole;
    });
    output = output.replace(/@import\s+(?:"([^"]+)"|'([^']+)')/gi, (whole, d, s) => {
        const local = localAsset(d ?? s, base);
        return local ? `@import "${local}"` : whole;
    });
    return output;
}
/**
 *
 * @param $
 * @param base
 */
function rewriteNodeAssets($, base) {
    $('img, picture source, video, audio, video source, audio source, script, link').each((_, node) => {
        const el = $(node);
        const tag = node.tagName?.toLowerCase();
        for (const attr of ['src', 'poster', 'data-src', 'data-original', 'data-lazy-src', 'data-image', 'data-url']) {
            const value = el.attr(attr);
            if (value) el.attr(attr, rewriteAsset(value, base));
        }
        if (tag === 'link' && el.attr('href')) el.attr('href', rewriteAsset(el.attr('href'), base));
        for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
            const value = el.attr(attr);
            if (value) el.attr(attr, rewriteSrcset(value, base));
        }
    });
    $('[style]').each((_, node) => $(node).attr('style', rewriteCss($(node).attr('style'), base)));
    $('style').each((_, node) => $(node).html(rewriteCss($(node).html() || '', base)));
    $('[data-background], [data-bg], [data-background-image], [data-bg-image]').each((_, node) => {
        const el = $(node);
        for (const attr of ['data-background', 'data-bg', 'data-background-image', 'data-bg-image']) {
            const value = el.attr(attr);
            if (value) el.attr(attr, /url\(/i.test(value) ? rewriteCss(value, base) : rewriteAsset(value, base));
        }
    });
}
/**
 *
 * @param $
 * @param base
 */
function rewriteGalleries($, base) {
    $('noscript').each((_, node) => {
        const el = $(node);
        const raw = el.html() || '';
        if (!/sigplus-(?:gallery|image)/i.test(`${el.attr('class') || ''} ${raw}`)) return;
        const gallery = cheerio.load(raw, { decodeEntities: false });
        gallery('a.sigplus-image').each((__, anchor) => {
            const a = gallery(anchor);
            if (a.attr('href')) a.attr('href', rewriteAsset(a.attr('href'), base));
        });
        rewriteNodeAssets(gallery, base);
        el.html(gallery.root().html());
    });
}
/**
 *
 * @param $
 * @param base
 */
function rewriteLinks($, base) {
    $('a[href]').each((_, node) => {
        const el = $(node);
        const raw = el.attr('href');
        if (!raw || /^(?:#|mailto:|tel:|javascript:)/i.test(raw.trim())) return;
        const u = resolve(raw, base);
        if (!u) return;
        const asset = assetByUrl.get(u.href);
        if (asset) { el.attr('href', `/__assets/${encodeURIComponent(asset.filename)}`); return; }
        const normalized = canonicalPath(u.pathname);
        const target = pageByUrl.get(u.href) || pageByPath.get(normalized);
        if (target) {
            el.attr('href', `${target.path}${u.search}${new URL(raw, base).hash}`);
        } else {
            const key = `${base} -> ${raw}`;
            if (!missing.has(key)) { missing.add(key); console.warn(`[preview] Unresolved internal link: ${key}`); }
            el.attr('href', `/__unresolved?url=${encodeURIComponent(u.href)}`);
        }
    });
}

// Diagnostic endpoint and sandboxed local asset serving
app.get('/__migration-status', (_, res) => res.json({
    source: site.sourceUrl, pages: pageByPath.size, homepage: pageByPath.has('/'),
    homepageMetadata: site.homepage || null, assets: assets.length
}));
app.get('/__unresolved', (req, res) => res.status(404).type('text/plain').send(`Unresolved internal source link: ${req.query.url || ''}`));
app.get('/__assets/:filename', async (req, res) => {
    const filename = req.params.filename;
    const item = assets.find(a => a.downloaded && a.filename === filename);
    if (!item || path.basename(filename) !== filename) return res.sendStatus(404);
    const target = path.resolve(assetsDir, filename);
    if (!target.startsWith(`${assetsDir}${path.sep}`)) return res.sendStatus(403);
    if (!await fs.pathExists(target)) return res.sendStatus(404);
    if (item.type === 'css') {
        try {
            const css = await fs.readFile(target, 'utf8');
            return res.type('text/css').send(rewriteCss(css, item.url));
        } catch (error) { return res.status(500).type('text/plain').send(error.message); }
    }
    if (item.contentType) res.type(item.contentType.split(';')[0]);
    return res.sendFile(target);
});

// Preview renders stored HTML; it never modifies page JSON.
app.get('/{*splat}', async (req, res) => {
    const requested = canonicalPath(req.path);
    const page = pageByPath.get(requested);
    if (!page) return res.status(404).type('text/plain').send(
        `Page not in crawl. Requested path: ${requested}\nCrawled pages: ${pageByPath.size}\nHomepage in manifest: ${Boolean(site.homepage)}\nHomepage in page map: ${pageByPath.has('/')}\n`
    );
    const filename = page.file || `${Buffer.from(page.url).toString('base64url')}.json`;
    if (filename !== path.basename(filename) || !filename.endsWith('.json')) return res.sendStatus(500);
    try {
        const record = await fs.readJson(path.join(migrationDir, 'pages', filename));
        const $ = cheerio.load(record.originalHtml, { decodeEntities: false });
        $('base').remove();
        rewriteNodeAssets($, record.url);
        rewriteGalleries($, record.url);
        rewriteLinks($, record.url);
        res.type('html').send($.html());
    } catch (error) {
        console.error(`[preview] Cannot load ${requested} (${filename}):`, error);
        res.status(500).type('text/plain').send(`Cannot load crawled page ${requested}: ${error.message}`);
    }
});
app.listen(port, () => console.log(`[preview] http://localhost:${port}/ | pages=${pageByPath.size} | homepage=${pageByPath.has('/') ? 'YES' : 'NO'}`));
