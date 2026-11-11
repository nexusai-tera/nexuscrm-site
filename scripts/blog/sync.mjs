#!/usr/bin/env node
// Pulls ready posts and unpublish requests from the n8n blog feed into blog/posts/*.json.
//   GET $BLOG_FEED_URL -> {"ok": true, "ready": [<post>...], "unpublish": ["<slug>", ...]}
// Guardrails (CONTRACTS.md section 6):
//   - up to 3 retries with backoff and a per-request timeout; non-2xx, bad JSON or a malformed
//     feed -> exit 1 without touching any file
//   - every ready post passes validatePost before it is written; slugs must be safe kebab-case
//   - at most 3 posts written and 2 removed per run; an existing post file is only overwritten
//     when the feed item has "replace": true
//   - hand-built posts ("source": "manual" in the current file) are never replaced or removed
//     by the feed unless BLOG_SYNC_ALLOW_MANUAL=1 is set for that run
//   - only the post fields are written, with "source": "n8n" (a feed item cannot claim "manual")
//   - removals delete only blog/posts/<slug>.json
//   - the feed is fetched without following redirects (a 3xx is an error)
// Exit codes: 0 all applied; 1 the feed could not be read or is malformed (nothing changed);
//   2 the feed was read and the valid items were applied, but at least one ready item failed
//   validation (it was not written; the workflow run goes red so the problem is seen).
// Usage: BLOG_FEED_URL=... node scripts/blog/sync.mjs [--root <site dir>]
// Test knobs: BLOG_SYNC_TIMEOUT_MS (default 20000), BLOG_SYNC_BACKOFF_MS (default 2000).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeSlug, loadPool, validatePost, annotate } from './lib.mjs';

export const MAX_WRITES = 3;
export const MAX_REMOVALS = 2;
const MAX_LIST = 50; // a feed listing more than this is treated as broken, not truncated
const MAX_BYTES = 5 * 1024 * 1024;
const RETRIES = 3;

// fields copied from a feed item into blog/posts/<slug>.json, in this order ("source" is set)
export const POST_FIELDS = ['slug', 'title', 'seo_title', 'description', 'excerpt', 'category', 'tags', 'date', 'updated', 'author', 'image', 'image_alt', 'body_html', 'faq', 'social', 'primary_keyword'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { status: res.status, error: `HTTP ${res.status} redirect${res.headers.get('location') ? ` to ${String(res.headers.get('location')).slice(0, 120)}` : ''}; redirects are not followed`, fatal: true };
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { status: res.status, error: `HTTP ${res.status}` };
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) { try { await res.body?.cancel(); } catch { /* ignore */ } return { status: res.status, error: `response too large (${declared} bytes)`, fatal: true }; }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } return { status: res.status, error: `response larger than ${MAX_BYTES} bytes`, fatal: true }; }
      chunks.push(value);
    }
    return { status: res.status, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFeed(url, { timeoutMs = 20000, backoffMs = 2000, log = () => {} } = {}) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await sleep(backoffMs * 2 ** (attempt - 1));
    last = await fetchOnce(url, timeoutMs);
    if (!last.error) return last;
    log(`attempt ${attempt + 1} of ${RETRIES + 1}: ${last.error}`);
    const retryable = !last.fatal && (last.status === 0 || last.status === 429 || last.status >= 500);
    if (!retryable) break;
  }
  return last;
}

// Checks the decoded feed. Returns { error } or { ready, unpublish }.
export function parseFeed(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { error: `feed is not valid JSON (${e.message})` }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'feed is not a JSON object' };
  if (data.ok !== true) return { error: 'feed does not say "ok": true' };
  const ready = data.ready === undefined ? [] : data.ready;
  const unpublish = data.unpublish === undefined ? [] : data.unpublish;
  if (!Array.isArray(ready)) return { error: '"ready" is not an array' };
  if (!Array.isArray(unpublish)) return { error: '"unpublish" is not an array' };
  if (ready.length > MAX_LIST || unpublish.length > MAX_LIST) return { error: `feed lists ${ready.length} ready and ${unpublish.length} unpublish items; more than ${MAX_LIST} is treated as a broken feed` };
  return { ready, unpublish };
}

// printable form of an untrusted value (never throws)
const show = (v) => { try { return JSON.stringify(typeof v === 'string' ? v.slice(0, 100) : v)?.slice(0, 100) ?? String(typeof v); } catch { return `<${typeof v}>`; } };

// "source" of the post file on disk ('' when unreadable)
function sourceOf(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j.source === 'string' ? j.source : ''; } catch { return ''; }
}

export async function sync({ root, feedUrl, now = new Date(), timeoutMs = 20000, backoffMs = 2000, allowManual = false, log = annotate } = {}) {
  const result = { exitCode: 0, written: [], removed: [], skipped: [], errors: [] };
  const problem = (msg) => { result.errors.push(msg); log('error', msg); };
  const note = (msg) => { result.skipped.push(msg); log('warning', msg); };

  if (!feedUrl) { problem('BLOG_FEED_URL is not set'); result.exitCode = 1; return result; }
  let u;
  try { u = new URL(feedUrl); } catch { problem('BLOG_FEED_URL is not a valid URL'); result.exitCode = 1; return result; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) {
    problem('BLOG_FEED_URL must be https'); result.exitCode = 1; return result;
  }

  const res = await fetchFeed(feedUrl, { timeoutMs, backoffMs, log: (m) => console.log(`feed: ${m}`) });
  if (res.error) { problem(`could not read the feed: ${res.error}; no files changed`); result.exitCode = 1; return result; }
  const feed = parseFeed(res.text);
  if (feed.error) { problem(`${feed.error}; no files changed`); result.exitCode = 1; return result; }

  const postsDir = path.join(root, 'blog', 'posts');
  const fileFor = (slug) => {
    const f = path.join(postsDir, `${slug}.json`);
    if (path.dirname(f) !== postsDir) throw new Error(`unsafe path for ${slug}`);
    return f;
  };
  let existing = [];
  try { existing = fs.readdirSync(postsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { existing = []; }
  const existingSet = new Set(existing);

  // removals (validated first, applied after the writes are planned)
  const removeSet = new Set();
  for (const s of feed.unpublish) {
    if (!isSafeSlug(s)) { note(`unpublish: unsafe slug ${show(s)} ignored`); continue; }
    removeSet.add(s);
  }
  const removals = [];
  for (const s of [...removeSet].sort()) {
    if (!existingSet.has(s)) { console.log(`unpublish: ${s} has no post file; nothing to remove`); continue; }
    if (!allowManual && sourceOf(fileFor(s)) === 'manual') { note(`unpublish: ${s} is a hand-built post ("source": "manual"); the feed cannot remove it (delete blog/posts/${s}.json in git, or run with BLOG_SYNC_ALLOW_MANUAL=1)`); continue; }
    if (removals.length >= MAX_REMOVALS) { note(`unpublish: cap of ${MAX_REMOVALS} removals per run reached; ${s} waits for the next run`); continue; }
    removals.push(s);
  }

  // ready posts
  const pool = loadPool(root);
  const items = [];
  const seen = new Set();
  for (const item of feed.ready) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { note('ready: an item is not an object; ignored'); continue; }
    if (!isSafeSlug(item.slug)) { note(`ready: unsafe slug ${show(item.slug)} ignored`); continue; }
    if (seen.has(item.slug)) { note(`ready: ${item.slug} listed twice; the first copy is used`); continue; }
    seen.add(item.slug);
    if (removeSet.has(item.slug)) { note(`ready: ${item.slug} is also listed for unpublishing; not written`); continue; }
    items.push(item);
  }
  // which items would be written (up-to-date, no-replace and manual items drop out here)
  let candidates = [];
  for (const item of items) {
    // Only the post fields (CONTRACTS.md section 2) are written, and the source is always
    // "n8n": a feed item can never mark itself as a hand-built post the feed cannot remove,
    // nor publish an extra field in the served blog/posts/<slug>.json.
    const { replace } = item;
    const post = Object.fromEntries(POST_FIELDS.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));
    post.source = 'n8n';
    const file = fileFor(post.slug);
    const content = JSON.stringify(post, null, 2) + '\n';
    if (existingSet.has(post.slug)) {
      let current = '';
      try { current = fs.readFileSync(file, 'utf8'); } catch { /* unreadable */ }
      if (current === content) { console.log(`ready: ${post.slug} is already up to date`); continue; }
      if (replace !== true) { note(`ready: ${post.slug} already exists and the feed item has no "replace": true; not overwritten`); continue; }
      if (!allowManual && sourceOf(file) === 'manual') { note(`ready: ${post.slug} is a hand-built post ("source": "manual"); the feed cannot replace it (edit blog/posts/${post.slug}.json in git, or run with BLOG_SYNC_ALLOW_MANUAL=1)`); continue; }
    }
    candidates.push({ slug: post.slug, post, file, content, replaced: existingSet.has(post.slug) });
  }

  // Validate until stable. Links between new items count only when the target is itself
  // written in this run, so a post is never written with a link to a rejected or deferred one.
  const base = existing.filter((s) => !removals.includes(s));
  const failed = new Map(); // slug -> errors (real validation failures, with every candidate counted)
  const deferred = new Map(); // slug -> reason (valid, but must wait for the next run)
  for (let round = 0; round < 20; round++) {
    const known = new Set([...base, ...candidates.map((c) => c.slug)]);
    const next = [];
    for (const c of candidates) {
      const v = validatePost(c.post, { pool: pool.images, root, knownSlugs: known, fileSlug: c.slug, now });
      if (v.ok) { next.push(c); continue; }
      if (round === 0) failed.set(c.slug, v.errors);
      else deferred.set(c.slug, `links to a post that is not written in this run (${v.errors.join('; ')})`);
    }
    const capped = next.slice(0, MAX_WRITES);
    for (const c of next.slice(MAX_WRITES)) deferred.set(c.slug, `cap of ${MAX_WRITES} posts per run reached`);
    const stable = capped.length === candidates.length;
    candidates = capped;
    if (stable) break;
  }
  for (const c of candidates) deferred.delete(c.slug);
  for (const [slug, errs] of failed) problem(`ready: ${slug} failed validation and was not written: ${errs.join('; ')}`);
  for (const [slug, why] of deferred) note(`ready: ${slug} waits for the next run: ${why}`);
  const writes = candidates;

  // apply
  if (writes.length) fs.mkdirSync(postsDir, { recursive: true });
  for (const w of writes) {
    const tmp = path.join(postsDir, `.${w.slug}.json.tmp`);
    fs.writeFileSync(tmp, w.content);
    fs.renameSync(tmp, w.file);
    result.written.push(`blog/posts/${w.slug}.json${w.replaced ? ' (replaced)' : ''}`);
  }
  for (const s of removals) {
    fs.unlinkSync(fileFor(s));
    result.removed.push(`blog/posts/${s}.json`);
  }
  if (failed.size && result.exitCode === 0) result.exitCode = 2;
  console.log(`blog sync: ${result.written.length} written${result.written.length ? ` (${result.written.join(', ')})` : ''}, ${result.removed.length} removed${result.removed.length ? ` (${result.removed.join(', ')})` : ''}, ${result.skipped.length + result.errors.length} item(s) not applied`);
  return result;
}

const here = fileURLToPath(import.meta.url);
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(here); } catch { return false; } })();
if (isMain) {
  const k = process.argv.indexOf('--root');
  const root = k !== -1 && process.argv[k + 1] ? path.resolve(process.argv[k + 1]) : path.resolve(path.dirname(here), '..', '..');
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== '' && v !== undefined ? Number(v) : d);
  const r = await sync({
    root,
    feedUrl: process.env.BLOG_FEED_URL,
    timeoutMs: num(process.env.BLOG_SYNC_TIMEOUT_MS, 20000),
    backoffMs: num(process.env.BLOG_SYNC_BACKOFF_MS, 2000),
    allowManual: process.env.BLOG_SYNC_ALLOW_MANUAL === '1',
  });
  process.exitCode = r.exitCode;
}
