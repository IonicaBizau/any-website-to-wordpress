import 'dotenv/config';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import config from '../config.js';

/*
 * DANGEROUS: deletes ALL REST-visible standard WordPress content on WP_URL,
 * not just content imported by this project. No database reset is performed.
 * Default is read-only. To execute, first review the printed inventory, then
 * run: node reset-wordpress-content.js --execute
 * The command requires an interactive terminal and an exact typed phrase.
 * Create a verified site/database/files backup BEFORE running --execute.
 */

const target = config.wpUrl?.replace(/\/+$/, '');
if (!target || !config.wpUsername || !config.wpAppPassword) {
    throw new Error('Set WP_URL, WP_USERNAME and WP_APP_PASSWORD in .env/config.js.');
}
const parsed = new URL(target);
if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('Use HTTPS for Application Password authentication (HTTP permitted only for localhost).');
}
const execute = process.argv.slice(2).includes('--execute');
if (process.argv.slice(2).some(flag => flag !== '--execute')) throw new Error('Only --execute is supported. Default mode is read-only.');
const api = axios.create({
    baseURL: `${target}/wp-json/wp/v2`,
    auth: { username: config.wpUsername, password: config.wpAppPassword },
    timeout: 30000
});
const groups = [
    { key: 'comments', route: '/comments', queries: [{ status: 'all' }, { status: 'trash' }] },
    { key: 'menuItems', route: '/menu-items', queries: [{}] },
    { key: 'menus', route: '/menus', queries: [{}] },
    { key: 'navigation', route: '/navigation', queries: [{ status: 'any' }, { status: 'trash' }], optional: true },
    { key: 'posts', route: '/posts', queries: [{ status: 'any' }, { status: 'trash' }] },
    { key: 'pages', route: '/pages', queries: [{ status: 'any' }, { status: 'trash' }] },
    { key: 'media', route: '/media', queries: [ { status: 'inherit' }, { status: 'private' }, { status: 'trash' } ] }
];

/**
 *
 * @param error
 */
function describe(error) {
    return `${error.response?.status || 'network'}: ${error.response?.data?.message || error.message}`;
}
/**
 *
 * @param route
 * @param params
 */
async function list(route, params) {
    const out = [];

    for (let page = 1; ; page++) {
        const response = await api.get(route, {
            params: {
                ...params,
                context: 'edit',
                per_page: 100,
                page,
                _fields: 'id,status,slug,title,link,source_url'
            }
        });

        if (!Array.isArray(response.data)) {
            throw new Error(`Unexpected response from ${route}`);
        }

        const rawPages = response.headers['x-wp-totalpages'];
        const rawTotal = response.headers['x-wp-total'];
        const total = Number(rawTotal);

        // WordPress can report zero pages for an empty collection.
        if (
            response.data.length === 0 &&
      rawTotal !== undefined &&
      total === 0 &&
      (rawPages === undefined || Number(rawPages) === 0)
        ) {
            return out;
        }

        const totalPages = Number(rawPages);

        if (
            rawPages === undefined ||
      !Number.isSafeInteger(totalPages) ||
      totalPages < 1 ||
      page > totalPages
        ) {
            throw new Error(
                `Missing/invalid pagination headers for ${route}; ` +
        `refusing to delete an incomplete inventory.`
            );
        }

        out.push(...response.data);

        if (page >= totalPages) {
            return out;
        }
    }
}
/**
 *
 * @param group
 */
async function inventory(group) {
    const items = new Map();
    for (const query of group.queries) {
        let result;
        try { result = await list(group.route, query); }
        catch (error) {
            if (group.optional && error.response?.status === 404) {
                console.warn(`Skipping unavailable optional route ${group.route}.`);
                return [];
            }
            throw new Error(`Cannot fully inventory ${group.route} ${JSON.stringify(query)}: ${describe(error)}. Nothing has been deleted.`);
        }
        for (const item of result) {
            if (!Number.isSafeInteger(item.id) || item.id <= 0) throw new Error(`Invalid ID in ${group.route} inventory.`);
            items.set(item.id, item);
        }
    }
    return [...items.values()].sort((a, b) => a.id - b.id);
}
/**
 *
 */
async function buildPlan() {
    const plan = {};
    for (const group of groups) plan[group.key] = await inventory(group);
    return plan;
}
/**
 *
 * @param plan
 */
function printPlan(plan) {
    console.log(`\nTARGET: ${target}\nSCOPE: ALL content on this WordPress site, including content unrelated to this migration.\n`);
    for (const group of groups) {
        const items = plan[group.key];
        console.log(`${group.key.padEnd(12)} ${String(items.length).padStart(6)}  ${items.slice(0, 4).map(x => `${x.id}:${x.slug || x.status || ''}`).join('  ')}`);
    }
    console.log('\nNOT removed: users, plugins, themes, settings, custom post types, terms/categories/tags, widgets, or files not tracked by the Media Library.');
    console.log('This is NOT a full WordPress database reset. The active homepage setting may need manual review afterward.');
    console.log('Your migration/ crawl and wordpress-import.json are not changed by this script.');
}
/**
 *
 * @param group
 * @param item
 * @param failures
 */
async function remove(group, item, failures) {
    const endpoint = `${group.route}/${item.id}`;
    try {
        const response = await api.delete(endpoint, { params: { force: true } });
        if (response.data?.deleted === false) throw new Error('WordPress reported deleted=false');
        console.log(`DELETED ${group.key} ${item.id}`);
    } catch (error) {
        if (error.response?.status === 404) {
            console.log(`ALREADY ABSENT ${group.key} ${item.id}`);
            return;
        }
        failures.push({ kind: group.key, id: item.id, endpoint, error: describe(error) });
        console.error(`FAILED ${group.key} ${item.id}: ${describe(error)}`);
    }
}
/**
 *
 */
async function main() {
    const user = (await api.get('/users/me', { params: { context: 'edit', _fields: 'id,name,roles' } })).data;
    console.log(`Authenticated as: ${user.name || user.id} (ID ${user.id})`);
    // Preflight must finish successfully for every required collection before any deletion.
    const plan = await buildPlan();
    printPlan(plan);
    if (!execute) {
        console.log('\nREAD-ONLY DRY RUN. To proceed after making a backup: node reset-wordpress-content.js --execute');
        return;
    }
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Execution requires an interactive terminal.');
    const phrase = `DELETE ALL CONTENT ON ${target}`;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let answer;
    try { answer = await rl.question(`\nPERMANENT DELETION. Type exactly:\n${phrase}\n> `); }
    finally { rl.close(); }
    if (answer !== phrase) throw new Error('Confirmation did not match. Nothing deleted.');
    const failures = [];
    // Deleting a collection while paginating it would skip IDs. We snapshot IDs first.
    for (const group of groups) for (const item of plan[group.key]) await remove(group, item, failures);
    console.log(`\nFinished. Failures: ${failures.length}`);
    if (failures.length) {
        const report = path.resolve('reset-wordpress-errors.json');
        await fs.writeJson(report, { target, at: new Date().toISOString(), failures }, { spaces: 2 });
        console.error(`Failure details written to ${report}`);
        process.exitCode = 1;
    } else {
        console.log('All inventoried standard content was deleted. Review homepage/settings and custom post types separately.');
        console.log('Before reimporting, archive/reset migration/wordpress-import.json ONLY after verifying the target is clear.');
    }
}
main().catch(error => {
    console.error(`RESET ABORTED: ${describe(error)}`);
    process.exitCode = 1;
});
