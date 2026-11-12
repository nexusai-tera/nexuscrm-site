// node --test scripts/blog/test.mjs
// Sanitizer, validator, build and sync tests. Builds and syncs run in temporary copies of the
// site with fixture posts and a fixture image pool; the real repo is never written.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sanitizeBody, tokenize, cleanHref, ALLOWED_TAGS, addHeadingIds, slugifyHeading, validatePost, escText, escAttr,
  rfc822Midnight, torontoMidnightOffset, formatDateDisplay, todayToronto, addDays, wordCount, extractChrome,
  literalAlt, GENERATOR_MARK, decodeEntities, readingMinutes, insertBeforeThirdH2, isoMidnight,
} from './lib.mjs';
import { build, nobrHyphens, linkPhone } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrm-blog-test-'));
const quiet = () => {};
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

// ------------------------------------------------------------------ fixtures

const WORDS = 'crew quote job margin labour materials receipt invoice schedule deposit estimate site visit driveway patio fence base gravel pavers permit holdback'.split(' ');
function words(n, seed = 0) {
  const out = [];
  for (let k = 0; k < n; k++) out.push(WORDS[(k * 7 + seed) % WORDS.length]);
  return out.join(' ');
}

const FIXTURE_POOL = {
  images: [
    { id: 'fx-crew', src: '/img/blog/fx-crew.jpg', card: '/img/blog/fx-crew-800.jpg', width: 1600, height: 840, alt: 'Two workers laying pavers along a string line', description: 'fixture', best_for: [], people: true, ai_generated: true },
    { id: 'fx-screen', src: '/img/blog/fx-screen.jpg', card: '/img/blog/fx-screen-800.jpg', width: 1600, height: 840, alt: 'Quote screen with sample data', description: 'fixture', best_for: [], people: false, ai_generated: false },
    { id: 'broll-legacy', src: '/img/blog/broll-legacy.jpg', card: '/img/blog/broll-legacy-800.jpg', width: 1600, height: 840, alt: 'Pickup truck in the snow', description: 'fixture without ai_generated', best_for: [], people: false },
    { id: 'cover-nexuscrm-youtube-banner', src: '/img/blog/cover-nexuscrm-youtube-banner.jpg', card: '/img/blog/cover-nexuscrm-youtube-banner-800.jpg', width: 1600, height: 840, alt: 'NexusCRM logo on a dark background', description: 'fixture', best_for: [], people: false, ai_generated: false },
  ],
};

function makePost(slug, o = {}) {
  const h2 = o.h2 ?? 5;
  const per = Math.ceil((o.words ?? 820) / Math.max(1, h2));
  let body = '<p>Opening paragraph that answers the question in two sentences.</p>\n';
  for (let k = 1; k <= h2; k++) body += `<h2>Section ${k} heading</h2>\n<p>${words(per, k)}</p>\n`;
  if (!h2) body += `<p>${words(o.words ?? 820)}</p>\n`;
  body += o.extraBody || '';
  body += '<p>Book a <a href="/contact.html">25-minute demo</a> or see <a href="https://crm.nexusaigta.ca/pricing.html">pricing</a>.</p>';
  return {
    slug,
    title: o.title || `How fixture post ${slug} explains job costing`,
    ...(o.seo_title ? { seo_title: o.seo_title } : {}),
    description: o.description || 'A fixture description that is long enough to pass the seventy character minimum for meta tags.',
    excerpt: o.excerpt || 'A fixture excerpt that is long enough to pass the eighty character minimum used for the blog cards.',
    category: o.category || 'Job costing',
    tags: o.tags || ['job costing', 'margin'],
    date: o.date || '2026-11-10',
    ...(o.updated ? { updated: o.updated } : {}),
    author: { name: o.author || 'The NexusCRM team' },
    image: o.image || 'fx-crew',
    image_alt: o.image_alt || 'Two workers laying pavers along a string line on a driveway',
    body_html: o.body_html || body,
    faq: o.faq ?? [{ q: 'What is job costing?', a: 'Tracking what each job really cost.\n\nThen comparing it to the quote.' }, { q: "Does it work for a 5 person crew & up?", a: 'Yes, crews of 4 to 15 people.' }],
    social: { facebook: 'Fixture caption https://crm.nexusaigta.ca/blog/' + slug + '.html' },
    source: 'manual',
    primary_keyword: 'job costing',
    ...(o.extra || {}),
  };
}

const COPY_SKIP = new Set(['.git', 'audit_marketing', 'proof', 'social', 'blog', 'node_modules', '.DS_Store', 'docs']);
let siteCounter = 0;
function makeSite({ posts = [], pool = FIXTURE_POOL } = {}) {
  const dir = path.join(TMP_ROOT, `site-${++siteCounter}`);
  fs.cpSync(REPO, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(REPO, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (COPY_SKIP.has(top) || path.basename(src) === '.DS_Store') return false;
      if (rel === path.join('img', 'blog') || rel.startsWith(path.join('img', 'blog') + path.sep)) return false;
      return true;
    },
  });
  fs.mkdirSync(path.join(dir, 'img', 'blog'), { recursive: true });
  if (pool) {
    fs.writeFileSync(path.join(dir, 'img', 'blog', 'pool.json'), JSON.stringify(pool, null, 2));
    for (const img of pool.images) {
      fs.writeFileSync(path.join(dir, img.src), Buffer.alloc(1000 + img.id.length, 1));
      fs.writeFileSync(path.join(dir, img.card), Buffer.alloc(500, 1));
    }
  }
  fs.mkdirSync(path.join(dir, 'blog', 'posts'), { recursive: true });
  for (const p of posts) writePost(dir, p);
  return dir;
}
function writePost(dir, p, name = p.slug) {
  fs.writeFileSync(path.join(dir, 'blog', 'posts', `${name}.json`), JSON.stringify(p, null, 2) + '\n');
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
function snapshot(dir) {
  const map = {};
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else map[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return map;
}
const runBuild = (dir) => build({ root: dir, log: quiet, now: new Date('2026-11-11T17:00:00Z') });
const ldOf = (html) => JSON.parse(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/.exec(html)[1]);
const hasPython = spawnSync('python3', ['-c', 'import xml.dom.minidom'], { stdio: 'ignore' }).status === 0;
function xmlWellFormed(file) {
  const r = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom as m; m.parse(sys.argv[1])', file], { encoding: 'utf8' });
  return r.status === 0 ? true : r.stderr;
}

// ------------------------------------------------------------------ sanitizer

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<script>alert(1)',
  '<scr<script>ipt>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<img src="javascript:alert(1)">',
  '<p onclick="alert(1)" onmouseover=alert(2) class="x" style="color:red" id="y">hi</p>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="\tjavascript:alert(1)">x</a>',
  '<a href="java\nscript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="java&Tab;script:alert(1)">x</a>',
  '<a href="java&NewLine;script:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>',
  '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="javascript&#58;alert(1)">x</a>',
  '<a href="&#1;javascript:alert(1)">x</a>',
  '<a href="java\u0000script:alert(1)">x</a>',
  '<a href="jav\u200Bascript:alert(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  "<a href='vbscript:msgbox(1)'>x</a>",
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="DATA:text/html,<script>alert(1)</script>">x</a>',
  '<a href="//evil.example/">x</a>',
  '<a href="/\\evil.example/">x</a>',
  '<a href="https://ok.example/" onclick="alert(1)">ok</a>',
  '<a href="https://ok.example/" href="javascript:alert(1)">first wins</a>',
  '<a href="javascript:alert(1)" href="https://ok.example/">first wins</a>',
  '<a title="x" onfocus="alert(1)" autofocus href="#a">t</a>',
  '<svg><script>alert(1)</script></svg>after',
  '<svg onload=alert(1)>',
  '<svg/onload=alert(1)>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<style>@import "javascript:alert(1)";</style>',
  '<style>p{}</style><p>kept</p>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<template><script>alert(1)</script></template>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<form action="javascript:alert(1)"><button>go</button></form>',
  '<textarea><script>alert(1)</script></textarea>',
  '<title><script>alert(1)</script></title>',
  '<!-- <script>alert(1)</script> -->',
  '<!--><script>alert(1)</script>-->',
  '<!--->x<script>alert(1)</script>',
  '<!-- unclosed comment <script>alert(1)</script>',
  '<![CDATA[<script>alert(1)</script>]]>',
  '<?xml version="1.0"?><p>pi</p>',
  '<!DOCTYPE html><p>doctype</p>',
  '<p>unclosed <strong>bold <em>both',
  '<ul><li>one<li>two<ul><li>nested<li>nested 2</ul><li>three',
  '<ol start="3"><li>a<ol><li>b</ol></ol></li></li></ol>',
  '</p></div></ul>stray end tags',
  '<table><tr><td colspan=2 onclick=x>a<td>b</table>',
  '<p>5 < 6 && 7 > 3 & done</p>',
  '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  '<a href="https://ok.example/"><a href="https://two.example/">nested</a></a>',
  '<h1>Title</h1><h2>a<h3>b</h3></h2>',
  '<div><span style="x">unwrapped</span></div>',
  '<a href="https://ok.example/" title="&quot; onmouseover=&quot;alert(1)">quote in title</a>',
  '<a href="https://ok.example/?a=1&b=2&amp;c=3">amps</a>',
  '<p title="x>y">attribute with gt</p>',
  '<a href="mailto:info@nexusaigta.ca">mail</a> <a href="tel:+14372416287">call</a> <a href="#faq">faq</a>',
  '<base href="javascript:/">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel="stylesheet" href="javascript:alert(1)">',
  '<video><source onerror="alert(1)"></video>',
  '<details open ontoggle=alert(1)>x</details>',
  '<a href="https://ok.example/',
  '<p>tag cut off at the end <a href="',
  '<plaintext><script>alert(1)</script>',
  '\u0000<p>nul</p>\u0001',
];

const ATTRS = { a: ['href', 'title', 'rel'], th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'], ol: ['start'], abbr: ['title'] };

function assertSafe(out, payload) {
  const stack = [];
  const lower = out.toLowerCase();
  for (const bad of ['<script', '<svg', '<math', '<iframe', '<style', '<object', '<embed', '<img', '<form', '<base', '<meta', '<link', '<template', '<noscript', '<textarea', '<video', '<details']) {
    assert.ok(!lower.includes(bad), `${JSON.stringify(payload)} -> ${JSON.stringify(out)} contains ${bad}`);
  }
  for (const tok of tokenize(out)) {
    if (tok.type === 'start') {
      assert.ok(ALLOWED_TAGS.has(tok.name), `disallowed <${tok.name}> in ${JSON.stringify(out)}`);
      for (const a of tok.attrs) {
        assert.ok((ATTRS[tok.name] || []).includes(a.name), `disallowed attribute ${a.name} on <${tok.name}> in ${JSON.stringify(out)}`);
        if (a.name === 'href') {
          const v = decodeEntities(a.value, true).replace(/[\u0000-\u0020]/g, '').toLowerCase();
          assert.ok(/^(https?:|mailto:|tel:|#|\/(?!\/)|[^:/?#]*(?:[/?#]|$))/.test(v), `bad href ${a.value}`);
          assert.ok(!/^(javascript|vbscript|data):/.test(v), `script href ${a.value}`);
        }
      }
      if (!['br', 'hr'].includes(tok.name)) stack.push(tok.name);
    } else if (tok.type === 'end') {
      assert.equal(stack.pop(), tok.name, `unbalanced </${tok.name}> in ${JSON.stringify(out)}`);
    } else {
      assert.ok(!/[<>]/.test(tok.text), `raw < or > in text of ${JSON.stringify(out)}`);
    }
  }
  assert.equal(stack.length, 0, `unclosed ${stack.join(',')} in ${JSON.stringify(out)}`);
}

describe('sanitizeBody', () => {
  test('XSS battery: only allowlisted, balanced, script-free markup survives', () => {
    for (const p of PAYLOADS) {
      const out = sanitizeBody(p);
      assertSafe(out, p);
      assert.equal(sanitizeBody(out), out, `not idempotent for ${JSON.stringify(p)}`);
    }
  });

  test('encoded and obfuscated script schemes are rejected', () => {
    for (const p of PAYLOADS.filter((x) => /^<a href=/i.test(x) && /script|data:|vbscript/i.test(x) && !x.startsWith('<a href="https://ok.example/"'))) {
      assert.ok(!/<a /.test(sanitizeBody(p)), `${p} kept a link: ${sanitizeBody(p)}`);
    }
    for (const h of ['javascript:x', ' javascript:x', 'java\tscript:x', '&#106;avascript:x', 'javascript&colon;x', 'jav&#x0A;ascript:x', 'data:text/html,x', 'vbscript:x', '//evil.example', '\\\\evil', 'foo:bar']) {
      assert.equal(cleanHref(h), null, h);
    }
    for (const h of ['https://ok.example/a', 'http://ok.example/', 'mailto:a@b.ca', 'tel:+14372416287', '#faq', '/pricing.html', 'pricing.html', '../pricing.html?x=1#y']) {
      assert.notEqual(cleanHref(h), null, h);
    }
  });

  test('h1 becomes h2; b/i map to strong/em; unknown tags are unwrapped', () => {
    assert.equal(sanitizeBody('<h1>Title</h1>'), '<h2>Title</h2>');
    assert.equal(sanitizeBody('<b>b</b><i>i</i>'), '<strong>b</strong><em>i</em>');
    assert.equal(sanitizeBody('<div><span style="x">unwrapped</span></div>'), 'unwrapped');
  });

  test('attributes: only the allowlist survives', () => {
    assert.equal(sanitizeBody('<p class="x" style="y" id="z" onclick="a">t</p>'), '<p>t</p>');
    assert.equal(sanitizeBody('<table><tr><th scope="col" colspan="2" class="x">a</th><td rowspan=3 colspan="x">b</td></tr></table>'), '<table><tr><th colspan="2" scope="col">a</th><td rowspan="3">b</td></tr></table>');
    assert.equal(sanitizeBody('<ol start="4" type="a"><li>x</li></ol>'), '<ol start="4"><li>x</li></ol>');
    assert.equal(sanitizeBody('<abbr title="Harmonized Sales Tax" class="x">HST</abbr>'), '<abbr title="Harmonized Sales Tax">HST</abbr>');
  });

  test('external links get rel="noopener", own-site and relative links do not', () => {
    assert.equal(sanitizeBody('<a href="https://www.canada.ca/x" rel="nofollow" target="_blank">c</a>'), '<a href="https://www.canada.ca/x" rel="noopener">c</a>');
    assert.equal(sanitizeBody('<a href="https://crm.nexusaigta.ca/pricing.html">p</a>'), '<a href="https://crm.nexusaigta.ca/pricing.html">p</a>');
    assert.equal(sanitizeBody('<a href="/pricing.html" title="Prices">p</a>'), '<a href="/pricing.html" title="Prices">p</a>');
  });

  test('stray < > & are escaped; entity references are kept', () => {
    assert.equal(sanitizeBody('<p>5 < 6 && 7 > 3 &amp; &mdash; &#8212;</p>'), '<p>5 &lt; 6 &amp;&amp; 7 &gt; 3 &amp; &mdash; &#8212;</p>');
    assert.equal(sanitizeBody('<p>&lt;script&gt;</p>'), '<p>&lt;script&gt;</p>');
    assert.equal(sanitizeBody('<a href="https://ok.example/?a=1&b=2&amp;c=3">q</a>'), '<a href="https://ok.example/?a=1&amp;b=2&amp;c=3" rel="noopener">q</a>');
  });

  test('unclosed tags, nested lists and stray end tags are balanced', () => {
    assert.equal(sanitizeBody('<p>unclosed <strong>bold <em>both'), '<p>unclosed <strong>bold <em>both</em></strong></p>');
    assert.equal(sanitizeBody('<ul><li>one<li>two<ul><li>nested<li>nested 2</ul><li>three'), '<ul><li>one</li><li>two<ul><li>nested</li><li>nested 2</li></ul></li><li>three</li></ul>');
    assert.equal(sanitizeBody('</p></div>stray<p>a<p>b'), 'stray<p>a</p><p>b</p>');
    assert.equal(sanitizeBody('<p>para<ul><li>x</li></ul>'), '<p>para</p><ul><li>x</li></ul>');
    assert.equal(sanitizeBody('<h2>a<h3>b</h3></h2>'), '<h2>a</h2><h3>b</h3>');
    assert.equal(sanitizeBody('<table><tr><td>a<td>b<tr><td>c</table>'), '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>');
  });

  test('comments, doctypes and dropped elements leave nothing behind', () => {
    assert.equal(sanitizeBody('<!-- hidden <script>x</script> -->ok'), 'ok');
    assert.equal(sanitizeBody('<svg><script>alert(1)</script><a href="https://x.example">y</a></svg>after'), 'after');
    // "<svg/onload=...>" is not self-closing (the slash is not right before ">"), so browsers put "after" inside the svg too
    assert.equal(sanitizeBody('<svg/onload=alert(1)>after'), '');
    assert.equal(sanitizeBody('<svg/>after'), 'after');
    assert.equal(sanitizeBody('<math><mi>x</mi></math>q'), 'q');
    assert.equal(sanitizeBody('<style>p{}</style><iframe src="x"></iframe><p>kept</p>'), '<p>kept</p>');
    assert.equal(sanitizeBody('<form><input value=x><button>b</button></form><p>after form</p>'), '<p>after form</p>');
    assert.equal(sanitizeBody('<noscript><p>x</p></noscript>z'), 'z');
    assert.equal(sanitizeBody('<!DOCTYPE html><p>doctype</p>'), '<p>doctype</p>');
    assert.equal(sanitizeBody('<p>cut <a href="'), '<p>cut </p>');
  });

  test('the launch posts in the repo come through unchanged apart from rel="noopener"', () => {
    const dir = path.join(REPO, 'blog', 'posts');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    for (const f of files) {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const out = sanitizeBody(p.body_html);
      assertSafe(out, f);
      assert.equal(out.replace(/ rel="noopener"/g, ''), p.body_html, `${f} changed by the sanitizer`);
    }
  });
});

describe('helpers', () => {
  test('heading ids: slug rules, reserved ids and duplicates', () => {
    assert.equal(slugifyHeading('Crew & payroll: Qu\u00E9bec rules!'), 'crew-and-payroll-quebec-rules');
    assert.equal(slugifyHeading('***'), 'section');
    assert.equal(slugifyHeading('a'.repeat(80)).length, 60);
    const { html, headings } = addHeadingIds('<h2>FAQ</h2><h2>Same</h2><h3>Same</h3><h2>Main</h2><h4>no id</h4>');
    assert.equal(html, '<h2 id="faq-2">FAQ</h2><h2 id="same">Same</h2><h3 id="same-2">Same</h3><h2 id="main-2">Main</h2><h4>no id</h4>');
    assert.deepEqual(headings.map((h) => h.level), [2, 2, 3, 2]);
  });

  test('escaping matches the Publish Monitor contract', () => {
    assert.equal(escText(`Job's "real" margin & <costs>`), `Job's "real" margin &amp; &lt;costs&gt;`);
    assert.equal(escAttr(`Job's "real"`), `Job's &quot;real&quot;`);
  });

  test('dates: ISO 8601 midnight in Toronto with its offset', () => {
    assert.equal(isoMidnight('2026-11-11'), '2026-11-11T00:00:00-05:00');
    assert.equal(isoMidnight('2026-07-01'), '2026-07-01T00:00:00-04:00');
    assert.equal(isoMidnight('2026-03-08'), '2026-03-08T00:00:00-05:00');
    assert.equal(isoMidnight('2026-03-09'), '2026-03-09T00:00:00-04:00');
  });

  test('display headings keep hyphenated words whole; the sales number becomes a tel: link', () => {
    assert.equal(nobrHyphens('Ontario year-end checklist'), 'Ontario <span class="nobr">year-end</span> checklist');
    assert.equal(nobrHyphens('<a href="/blog/a-b.html">re-do</a>'), '<a href="/blog/a-b.html"><span class="nobr">re-do</span></a>');
    assert.equal(nobrHyphens('no hyphen &amp; 4\u201315 crews'), 'no hyphen &amp; 4\u201315 crews');
    assert.equal(linkPhone('<p>or call (437) 241-6287.</p>'), '<p>or call <a href="tel:+14372416287">(437) 241-6287</a>.</p>');
    const linked = '<p><a href="tel:+14372416287">(437) 241-6287</a></p>';
    assert.equal(linkPhone(linked), linked, 'an existing link is left alone');
  });

  test('dates: display format and RFC 822 midnight in Toronto', () => {
    assert.equal(formatDateDisplay('2026-11-17'), 'Nov 17, 2026');
    assert.equal(formatDateDisplay('2027-01-05'), 'Jan 5, 2027');
    assert.equal(rfc822Midnight('2026-11-17'), 'Tue, 17 Nov 2026 00:00:00 -0500');
    assert.equal(rfc822Midnight('2026-07-01'), 'Wed, 01 Jul 2026 00:00:00 -0400');
    assert.equal(todayToronto(new Date('2026-11-12T03:00:00Z')), '2026-11-11');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    // the rule-based offset agrees with the time-zone database for every day of 2024-2030
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', timeZoneName: 'longOffset' });
    for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2031, 0, 1); t += 86400000) {
      const ymd = new Date(t).toISOString().slice(0, 10);
      const probe = new Date(`${ymd}T04:30:00Z`);
      const tz = fmt.formatToParts(probe).find((p) => p.type === 'timeZoneName').value.replace('GMT', '').replace(':', '');
      assert.equal(torontoMidnightOffset(ymd), tz, ymd);
    }
  });

  test('word count, reading time and literal alt text', () => {
    assert.equal(wordCount('<p>one two</p><ul><li>three</li><li>four&nbsp;five</li></ul>'), 5);
    assert.equal(readingMinutes(0), 1);
    assert.equal(readingMinutes(231), 2);
    assert.equal(literalAlt('AI-generated image: two workers in toques'), 'Two workers in toques');
    assert.equal(literalAlt('Plain alt'), 'Plain alt');
  });

  test('chrome from index.html: links prefixed, Blog current, beacon copied verbatim', () => {
    const index = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    const c = extractChrome(index);
    assert.deepEqual(c.errors, []);
    assert.ok(c.nav.includes('<a class="logo" href="../index.html">'));
    assert.ok(c.nav.includes('<a href="../blog/" aria-current="page">Blog</a>'));
    assert.equal((c.nav.match(/aria-current/g) || []).length, 1);
    assert.ok(c.nav.includes('href="tel:+14372416287"'));
    assert.ok(c.footer.includes('<li><a href="../blog/">Blog</a></li>'));
    assert.ok(c.footer.includes('href="https://www.nexusaigta.ca"'));
    assert.ok(c.footer.includes('href="../industries/plumbers.html"'));
    assert.ok(!c.footer.includes('accountants.html'), 'the accountants page is not linked from blog pages');
    assert.ok(index.split('\n').includes(c.beacon));
    // an index.html without the Blog link still gets one on blog pages
    const old = index.replace(/\n {6}<a href="blog\/">Blog<\/a>/, '').replace(/\n {10}<li><a href="blog\/">Blog<\/a><\/li>/, '');
    const c2 = extractChrome(old);
    assert.ok(c2.nav.includes('<a href="../blog/" aria-current="page">Blog</a>'));
    assert.ok(c2.footer.includes('<li><a href="../blog/">Blog</a></li>'));
  });
});

// ------------------------------------------------------------------ validator

describe('validatePost', () => {
  let site;
  let pool;
  before(() => {
    site = makeSite();
    pool = new Map(FIXTURE_POOL.images.map((i) => [i.id, i]));
  });
  const ctx = (extra = {}) => ({ pool, root: site, knownSlugs: new Set(['other-post']), now: new Date('2026-11-11T17:00:00Z'), ...extra });
  const check = (mut, field, extra) => {
    const p = makePost('fixture-post');
    mut(p);
    const r = validatePost(p, ctx(extra));
    assert.equal(r.ok, false, `expected an error on ${field}`);
    assert.ok(r.errors.some((e) => e.startsWith(field)), `${field} not in ${JSON.stringify(r.errors)}`);
  };

  test('a well-formed post passes; unknown fields are ignored', () => {
    const p = makePost('fixture-post', { extra: { something_new: 1 } });
    const r = validatePost(p, ctx({ fileSlug: 'fixture-post' }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  test('field rules', () => {
    check((p) => { p.slug = 'Bad_Slug'; }, 'slug');
    check((p) => { p.slug = 'ab'; }, 'slug');
    check((p) => { p.slug = 'a'.repeat(81); }, 'slug');
    check(() => {}, 'slug', { fileSlug: 'different-name' });
    check((p) => { p.title = 'Too short'; }, 'title');
    check((p) => { p.title = 'x'.repeat(91); }, 'title');
    check((p) => { delete p.title; }, 'title');
    check((p) => { p.seo_title = 'x'.repeat(61); }, 'seo_title');
    check((p) => { p.description = 'short'; }, 'description');
    check((p) => { p.description = 'x'.repeat(161); }, 'description');
    check((p) => { p.excerpt = 'short excerpt'; }, 'excerpt');
    check((p) => { p.category = 'Marketing'; }, 'category');
    check((p) => { p.tags = ['one']; }, 'tags');
    check((p) => { p.tags = ['a', 'b', 'c', 'd', 'e', 'f', 'g']; }, 'tags');
    check((p) => { p.tags = ['Job Costing', 'margin']; }, 'tags');
    check((p) => { p.date = '2026-02-30'; }, 'date');
    check((p) => { p.date = '11/11/2026'; }, 'date');
    check((p) => { p.date = '2026-11-14'; }, 'date');
    check((p) => { p.updated = '2026-13-01'; }, 'updated');
    check((p) => { p.author = { name: '' }; }, 'author');
    check((p) => { p.image = 'not-in-pool'; }, 'image');
    check((p) => { p.image_alt = 'short'; }, 'image_alt');
    check((p) => { p.faq = Array.from({ length: 9 }, () => ({ q: 'q?', a: 'a' })); }, 'faq');
    check((p) => { p.faq = [{ q: 'x'.repeat(201), a: 'a' }]; }, 'faq[0].q');
    check((p) => { p.faq = [{ q: 'q?', a: 'x'.repeat(901) }]; }, 'faq[0].a');
    assert.equal(validatePost('nope', ctx()).ok, false);
    assert.equal(validatePost(makePost('fixture-post', { date: '2026-11-12' }), ctx()).ok, true, 'one day ahead is allowed');
  });

  test('body length: 700-3,500 words', () => {
    check((p) => { p.body_html = `<p>${words(300)}</p>`; }, 'body_html');
    check((p) => { p.body_html = `<p>${words(3600)}</p>`; }, 'body_html');
  });

  test('links: https, root-relative, #, mailto and tel only; internal targets must exist', () => {
    const withLink = (href) => (p) => { p.body_html += `<p><a href="${href}">link</a></p>`; };
    check(withLink('javascript:alert(1)'), 'body_html');
    check(withLink('&#106;avascript:alert(1)'), 'body_html');
    check(withLink('http://www.canada.ca/'), 'body_html');
    check(withLink('pricing.html'), 'body_html');
    check(withLink('/no-such-page.html'), 'body_html');
    check(withLink('https://crm.nexusaigta.ca/no-such-page.html'), 'body_html');
    check(withLink('/blog/unknown-post.html'), 'body_html');
    check(withLink('/blog/other-post/'), 'body_html');
    check(withLink('/../etc/passwd'), 'body_html');
    check(withLink('//evil.example/'), 'body_html');
    check((p) => { p.body_html += '<p><a>no href</a></p>'; }, 'body_html');
    for (const ok of ['/pricing.html', '/pricing.html#tiers', '/industries/plumbers.html', 'https://crm.nexusaigta.ca/contact.html', '/blog/other-post.html', '/blog/', 'https://www.wsib.ca/en', '#faq', 'mailto:info@nexusaigta.ca', 'tel:+14372416287']) {
      const p = makePost('fixture-post');
      withLink(ok)(p);
      const r = validatePost(p, ctx());
      assert.deepEqual(r.errors, [], ok);
    }
  });

  test('scripts and event handlers are errors; classes and images are warnings', () => {
    check((p) => { p.body_html += '<script>alert(1)</script>'; }, 'body_html');
    check((p) => { p.body_html += '<p onclick="x">t</p>'; }, 'body_html');
    check((p) => { p.body_html += '<iframe src="https://x.example"></iframe>'; }, 'body_html');
    const p = makePost('fixture-post');
    p.body_html += '<p class="x">t</p><img src="/img/x.jpg" alt="">';
    const r = validatePost(p, ctx());
    assert.equal(r.ok, true);
    assert.ok(r.warnings.length >= 2);
  });
});

// ------------------------------------------------------------------ build

describe('build', () => {
  test('0 posts: empty-state index, valid empty feed, markers created and empty', () => {
    const dir = makeSite();
    // start from files without markers so their creation is tested
    const strip = (f, re) => fs.writeFileSync(path.join(dir, f), read(dir, f).replace(re, ''));
    strip('sitemap.xml', /[ \t]*<!-- blog:start[\s\S]*?<!-- blog:end -->\n/);
    strip('llms.txt', /\n*<!-- blog:start -->[\s\S]*?<!-- blog:end -->\n?/);
    assert.ok(!read(dir, 'sitemap.xml').includes('blog:start') && !read(dir, 'llms.txt').includes('blog:start'));
    const r = runBuild(dir);
    assert.equal(r.exitCode, 0);
    const index = read(dir, 'blog/index.html');
    assert.ok(index.includes('<meta name="robots" content="noindex, follow">'));
    assert.ok(index.includes('The first posts are on the way.'));
    assert.ok(!index.includes('id="posts"'));
    assert.deepEqual(JSON.parse(read(dir, 'blog/posts.json')), { posts: [] });
    const feed = read(dir, 'blog/feed.xml');
    assert.ok(!feed.includes('<item>'));
    assert.ok(feed.includes('<atom:link href="https://crm.nexusaigta.ca/blog/feed.xml" rel="self" type="application/rss+xml"/>'));
    const sm = read(dir, 'sitemap.xml');
    assert.match(sm, /  <!-- blog:start generated by scripts\/blog\/build\.mjs; do not edit by hand -->\n  <!-- blog:end -->\n<\/urlset>\n?$/);
    const llms = read(dir, 'llms.txt');
    assert.match(llms, /\n\n<!-- blog:start -->\n<!-- blog:end -->\n$/);
    if (hasPython) { assert.equal(xmlWellFormed(path.join(dir, 'blog/feed.xml')), true); assert.equal(xmlWellFormed(path.join(dir, 'sitemap.xml')), true); }
    const before = snapshot(dir);
    assert.equal(runBuild(dir).written.length, 0);
    assert.deepEqual(snapshot(dir), before, 'second run changed files');
  });

  test('1 post: page structure, escaping, metadata, chrome and featured card', () => {
    const title = `Job costing for contractors: see each job's real margin & more`;
    const post = makePost('job-costing-fixture', { title, h2: 3, extraBody: '<h2>Tables</h2><table><caption>Example job costs</caption><thead><tr><th>Line</th><th>Cost</th></tr></thead><tbody><tr><td>Labour</td><td>$1</td></tr></tbody></table><h1>Inline h1</h1><p class="x" style="color:red">clean</p><img src="/img/x.jpg" alt="x"><div><span>unwrapped</span></div><p><a href="https://www.canada.ca/en.html" target="_blank">CRA</a></p>' });
    const dir = makeSite({ posts: [post] });
    const r = runBuild(dir);
    assert.equal(r.exitCode, 0, r.errors.join('\n'));
    const page = read(dir, 'blog/job-costing-fixture.html');
    assert.ok(page.includes('<link rel="canonical" href="https://crm.nexusaigta.ca/blog/job-costing-fixture.html">'));
    assert.ok(page.includes(`<h1>${escText(title)}</h1>`));
    assert.ok(page.includes(`<h1>Job costing for contractors: see each job's real margin &amp; more</h1>`));
    assert.ok(page.includes(`<title>${escText(title)} | NexusCRM</title>`));
    assert.ok(page.includes(`<meta property="og:title" content="${escAttr(title)}">`));
    assert.ok(page.includes('<meta property="og:type" content="article">'));
    assert.ok(page.includes('<meta property="og:image" content="https://crm.nexusaigta.ca/img/blog/fx-crew.jpg">'));
    assert.ok(page.includes('<meta property="og:image:width" content="1600">') && page.includes('<meta property="og:image:height" content="840">'));
    assert.ok(page.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(page.includes('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">'));
    assert.ok(page.includes('<meta property="article:published_time" content="2026-11-10T00:00:00-05:00">'));
    assert.ok(page.includes('<figcaption>AI-generated illustration</figcaption>'));
    // on a post the Blog link marks the section, not the current page
    assert.ok(page.includes('<a href="../blog/" aria-current="true">Blog</a>'));
    assert.ok(!page.includes('aria-current="page">Blog'));
    assert.ok(page.includes('<script src="../js/main.js"></script>'));
    const beacon = read(dir, 'index.html').split('\n').find((l) => l.includes('static.cloudflareinsights.com/beacon.min.js'));
    assert.ok(page.includes(`<script src="../js/main.js"></script>\n${beacon}\n</body>`));
    assert.ok(!page.includes('demo-form') && !page.includes('<form'));
    assert.ok(!/class="[^"]*\bcard\b/.test(page), 'blog pages must not use .card');
    // the body is sanitized (warnings only, so the post is still published)
    assert.ok(page.includes('<h2 id="inline-h1">Inline h1</h2>') && page.includes('<p>clean</p>') && page.includes('unwrapped'));
    assert.ok(!page.includes('style="color:red"') && !page.includes('/img/x.jpg') && !page.includes('target="_blank"') && !page.includes('<div><span>'));
    assert.ok(r.warnings.some((w) => w.includes('class attributes')));
    assert.ok(page.includes('<a href="https://www.canada.ca/en.html" rel="noopener">CRA</a>'));
    assert.ok(page.includes('<div class="tbl-scroll wide" role="region" tabindex="0" aria-label="Example job costs"><table class="cmp"><caption>'));
    // 4 h2s: TOC and the inline CTA before the 3rd h2
    assert.ok(page.includes('<nav class="toc"'));
    const cta = page.indexOf('<aside class="post-cta"');
    const h2s = [...page.matchAll(/<h2 id="(section|tables|inline)/g)].map((m) => m.index);
    assert.ok(cta > h2s[1] && cta < h2s[2], 'inline CTA sits before the 3rd h2');
    // FAQ as details, FAQ JSON-LD matching the visible text
    const faqHtml = page.slice(page.indexOf('<section class="post-faq"'), page.indexOf('</section>', page.indexOf('<section class="post-faq"')));
    assert.equal((faqHtml.match(/<details>/g) || []).length, 2);
    assert.ok(page.includes('<summary>Does it work for a 5 person crew &amp; up?</summary>'));
    assert.ok(page.includes('<div class="a"><p>Tracking what each job really cost.</p><p>Then comparing it to the quote.</p></div>'));
    const ld = ldOf(page);
    const types = ld['@graph'].map((g) => g['@type']);
    assert.deepEqual(types, ['BlogPosting', 'BreadcrumbList', 'FAQPage']);
    assert.equal(ld['@graph'][0].headline, title);
    assert.equal(ld['@graph'][0].datePublished, '2026-11-10T00:00:00-05:00');
    assert.equal(ld['@graph'][0].dateModified, '2026-11-10T00:00:00-05:00');
    assert.equal(ld['@graph'][1].itemListElement[2].name, title);
    assert.equal(ld['@graph'][2].mainEntity[0].acceptedAnswer.text, 'Tracking what each job really cost. Then comparing it to the quote.');
    // end CTA band with the demo and the phone number
    assert.ok(page.includes('<a class="btn btn-solid" href="../contact.html">Book a Demo</a>'));
    assert.ok(page.includes('Book a 25-minute demo'));
    assert.ok(page.includes('<a href="tel:+14372416287">(437) 241-6287</a>'));
    // no related section with a single post
    assert.ok(!page.includes('related-title'));
    // index: featured only, no grid, Blog JSON-LD, og:image = brand cover
    const index = read(dir, 'blog/index.html');
    assert.ok(index.includes('post-card post-featured'));
    assert.ok(!index.includes('id="posts"'));
    assert.ok(index.includes('<meta property="og:image" content="https://crm.nexusaigta.ca/img/blog/cover-nexuscrm-youtube-banner.jpg">'));
    assert.deepEqual(ldOf(index)['@graph'].map((g) => g['@type']), ['CollectionPage', 'Blog', 'BreadcrumbList']);
    assert.equal(ldOf(index)['@graph'][1].blogPost.length, 1);
    // feed
    const feed = read(dir, 'blog/feed.xml');
    assert.ok(feed.includes(`<title>${escAttr(title)}</title>`));
    assert.ok(feed.includes('<pubDate>Tue, 10 Nov 2026 00:00:00 -0500</pubDate>'));
    const bytes = fs.statSync(path.join(dir, 'img', 'blog', 'fx-crew.jpg')).size;
    assert.ok(feed.includes(`<enclosure url="https://crm.nexusaigta.ca/img/blog/fx-crew.jpg" length="${bytes}" type="image/jpeg"/>`));
    assert.ok(feed.includes('<content:encoded><![CDATA['));
    assert.ok(feed.includes('href="https://crm.nexusaigta.ca/contact.html"'), 'root-relative links are absolute in the feed');
    assert.ok(feed.includes('<h2 id="inline-h1">Inline h1</h2>') && !feed.includes('style="color:red"'));
    if (hasPython) assert.equal(xmlWellFormed(path.join(dir, 'blog/feed.xml')), true);
    // manifest
    const m = JSON.parse(read(dir, 'blog/posts.json')).posts;
    assert.equal(m.length, 1);
    assert.equal(m[0].url, 'https://crm.nexusaigta.ca/blog/job-costing-fixture.html');
    assert.equal(m[0].image_url, 'https://crm.nexusaigta.ca/img/blog/fx-crew.jpg');
    assert.ok(m[0].read_minutes >= 1 && m[0].word_count > 700);
  });

  test('3 posts: ordering, grid, related posts, TOC and CTA thresholds, idempotent', () => {
    const a = makePost('alpha-post', { date: '2026-11-01', category: 'Job costing', h2: 2, image: 'fx-screen' });
    const b = makePost('bravo-post', { date: '2026-11-08', category: 'Operations', tags: ['scheduling', 'margin'], h2: 3, image: 'broll-legacy', faq: [] });
    const c = makePost('charlie-post', { date: '2026-11-08', category: 'Job costing', h2: 6, updated: '2026-11-10', author: 'Shaheen Rashidi', extraBody: '<p>See <a href="/blog/alpha-post.html">alpha</a>.</p>' });
    const dir = makeSite({ posts: [a, b, c] });
    const r = runBuild(dir);
    assert.equal(r.exitCode, 0, r.errors.join('\n'));
    assert.deepEqual(r.posts, ['bravo-post', 'charlie-post', 'alpha-post']);
    const index = read(dir, 'blog/index.html');
    assert.ok(index.indexOf('href="bravo-post.html"') < index.indexOf('href="charlie-post.html"'));
    assert.equal((index.match(/<article class="post-card">/g) || []).length, 2);
    assert.ok(index.includes('<article class="post-card post-featured">'));
    // related: same category first
    const pageA = read(dir, 'blog/alpha-post.html');
    const rel = pageA.slice(pageA.indexOf('related-title'));
    assert.ok(rel.indexOf('charlie-post.html') < rel.indexOf('bravo-post.html'));
    assert.ok(!rel.includes('href="alpha-post.html"'));
    // thresholds: 2 h2s -> no TOC, no inline CTA; 3 h2s -> CTA, no TOC; 6 -> both
    assert.ok(!pageA.includes('<nav class="toc"') && !pageA.includes('<aside class="post-cta"'));
    const pageB = read(dir, 'blog/bravo-post.html');
    assert.ok(!pageB.includes('<nav class="toc"') && pageB.includes('<aside class="post-cta"'));
    assert.ok(!pageB.includes('id="faq"') && !pageB.includes('FAQPage'));
    assert.ok(pageB.includes('<figcaption>AI-generated illustration</figcaption>'), 'broll-* without the field counts as AI-generated');
    assert.ok(!pageA.includes('<figcaption>'), 'no caption for a non-AI image');
    const pageC = read(dir, 'blog/charlie-post.html');
    assert.ok(pageC.includes('<nav class="toc"') && pageC.includes('<li><a href="#faq">Questions, answered</a></li>'));
    assert.ok(pageC.includes('<span>Updated <time datetime="2026-11-10">Nov 10, 2026</time></span>'));
    assert.ok(pageC.includes('<aside class="author-box"'));
    assert.equal(ldOf(pageC)['@graph'][0].author['@type'], 'Person');
    assert.equal(ldOf(pageC)['@graph'][0].dateModified, '2026-11-10T00:00:00-05:00');
    // feed order and sitemap/llms blocks
    const feed = read(dir, 'blog/feed.xml');
    assert.ok(feed.indexOf('bravo-post') < feed.indexOf('charlie-post') && feed.indexOf('charlie-post') < feed.indexOf('alpha-post'));
    assert.ok(feed.includes('<lastBuildDate>Tue, 10 Nov 2026 00:00:00 -0500</lastBuildDate>'));
    const sm = read(dir, 'sitemap.xml');
    assert.equal((sm.match(/<!-- blog:start/g) || []).length, 1);
    assert.ok(sm.includes('<url><loc>https://crm.nexusaigta.ca/blog/</loc><lastmod>2026-11-10</lastmod>'));
    assert.ok(sm.includes('<url><loc>https://crm.nexusaigta.ca/blog/charlie-post.html</loc><lastmod>2026-11-10</lastmod>'));
    const llms = read(dir, 'llms.txt');
    assert.equal((llms.match(/<!-- blog:start -->/g) || []).length, 1);
    assert.ok(llms.includes('- [How fixture post bravo-post explains job costing](https://crm.nexusaigta.ca/blog/bravo-post.html)'));
    if (hasPython) for (const f of ['blog/feed.xml', 'sitemap.xml']) assert.equal(xmlWellFormed(path.join(dir, f)), true, f);
    // idempotent: a second and third run change nothing
    const before = snapshot(dir);
    assert.equal(runBuild(dir).written.length, 0);
    assert.equal(runBuild(dir).written.length, 0);
    assert.deepEqual(snapshot(dir), before);
    // no timestamps from the clock
    const later = build({ root: dir, log: quiet, now: new Date('2026-11-12T12:00:00Z') });
    assert.equal(later.written.length, 0);
  });

  test('orphan cleanup removes only generated pages', () => {
    const dir = makeSite({ posts: [makePost('keep-post'), makePost('gone-post', { date: '2026-11-09' })] });
    assert.equal(runBuild(dir).exitCode, 0);
    assert.ok(exists(dir, 'blog/gone-post.html'));
    fs.writeFileSync(path.join(dir, 'blog', 'hand-made.html'), '<!DOCTYPE html><title>hand made</title>');
    fs.unlinkSync(path.join(dir, 'blog', 'posts', 'gone-post.json'));
    const r = runBuild(dir);
    assert.deepEqual(r.removed, ['blog/gone-post.html']);
    assert.ok(!exists(dir, 'blog/gone-post.html'));
    assert.ok(exists(dir, 'blog/hand-made.html'), 'a page without the generator mark is kept');
    assert.ok(exists(dir, 'blog/keep-post.html'));
    assert.ok(!read(dir, 'blog/index.html').includes('gone-post'));
    assert.ok(!read(dir, 'sitemap.xml').includes('gone-post'));
    assert.ok(read(dir, 'blog/keep-post.html').includes(GENERATOR_MARK));
  });

  test('markers: replaced in place when present; unbalanced markers stop the build', () => {
    const dir = makeSite({ posts: [makePost('marker-post')] });
    const stripBlocks = () => {
      fs.writeFileSync(path.join(dir, 'sitemap.xml'), read(dir, 'sitemap.xml').replace(/[ \t]*<!-- blog:start[\s\S]*?<!-- blog:end -->\n/g, ''));
      fs.writeFileSync(path.join(dir, 'llms.txt'), read(dir, 'llms.txt').replace(/\n*<!-- blog:start -->[\s\S]*?<!-- blog:end -->\n?/g, '\n'));
    };
    // a second block is refused, with nothing written
    fs.writeFileSync(path.join(dir, 'sitemap.xml'), read(dir, 'sitemap.xml').replace('</urlset>', '  <!-- blog:start x -->\n  <!-- blog:end -->\n  <!-- blog:start y -->\n  <!-- blog:end -->\n</urlset>'));
    const dupBefore = snapshot(dir);
    assert.equal(runBuild(dir).exitCode, 1);
    assert.deepEqual(snapshot(dir), dupBefore);
    stripBlocks();
    const sm0 = read(dir, 'sitemap.xml').replace('</urlset>', '  <!-- blog:start old -->\n  <url><loc>https://crm.nexusaigta.ca/blog/stale.html</loc></url>\n  <!-- blog:end -->\n  <url><loc>https://crm.nexusaigta.ca/after.html</loc></url>\n</urlset>');
    fs.writeFileSync(path.join(dir, 'sitemap.xml'), sm0);
    fs.writeFileSync(path.join(dir, 'llms.txt'), read(dir, 'llms.txt') + '\n<!-- blog:start -->\nstale\n<!-- blog:end -->\n\n## Later section\n');
    assert.equal(runBuild(dir).exitCode, 0);
    const sm = read(dir, 'sitemap.xml');
    assert.ok(!sm.includes('stale.html') && sm.includes('marker-post.html'));
    assert.ok(sm.includes('<!-- blog:end -->\n  <url><loc>https://crm.nexusaigta.ca/after.html</loc></url>'), 'content after the block is kept');
    assert.equal((sm.match(/blog:start/g) || []).length, 1);
    const llms = read(dir, 'llms.txt');
    assert.ok(!llms.includes('stale') && llms.includes('marker-post.html') && llms.endsWith('<!-- blog:end -->\n\n## Later section\n'));
    // unbalanced
    fs.writeFileSync(path.join(dir, 'sitemap.xml'), sm.replace('  <!-- blog:end -->\n', ''));
    const before = snapshot(dir);
    const r = runBuild(dir);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(snapshot(dir), before);
  });

  test('invalid posts are skipped; all-invalid exits 1 without touching anything', () => {
    const good = makePost('good-post');
    const bad = makePost('bad-post', { category: 'Nope' });
    const dir = makeSite({ posts: [good, bad] });
    fs.writeFileSync(path.join(dir, 'blog', 'posts', 'broken-json.json'), '{ nope');
    fs.writeFileSync(path.join(dir, 'blog', 'posts', 'Bad Name.json'), JSON.stringify(good));
    writePost(dir, makePost('mismatch-post'), 'other-name');
    const r = runBuild(dir);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.posts, ['good-post']);
    assert.ok(r.errors.length >= 4);
    assert.ok(!exists(dir, 'blog/bad-post.html'));
    // a post that becomes invalid keeps its existing page (never wipe because of one bad file)
    writePost(dir, makePost('bad-post'));
    assert.equal(runBuild(dir).exitCode, 0);
    assert.ok(exists(dir, 'blog/bad-post.html'));
    writePost(dir, makePost('bad-post', { category: 'Nope' }));
    assert.equal(runBuild(dir).exitCode, 0);
    assert.ok(exists(dir, 'blog/bad-post.html'), 'page of an invalid source is kept');
    // every post invalid: exit 1, nothing written
    writePost(dir, makePost('good-post', { title: 'short' }));
    const before = snapshot(dir);
    const r2 = runBuild(dir);
    assert.equal(r2.exitCode, 1);
    assert.deepEqual(snapshot(dir), before);
    // the CLI reports the same exit code
    const cli = spawnSync(process.execPath, [path.join(dir, 'scripts', 'blog', 'build.mjs')], { encoding: 'utf8' });
    assert.equal(cli.status, 1, cli.stderr);
    assert.deepEqual(snapshot(dir), before);
  });

  test('index og:image falls back to the newest post image without the brand cover', () => {
    const pool = { images: FIXTURE_POOL.images.filter((i) => i.id !== 'cover-nexuscrm-youtube-banner') };
    const dir = makeSite({ posts: [makePost('older-post', { date: '2026-11-01' }), makePost('newer-post', { date: '2026-11-09', image: 'fx-screen' })], pool });
    assert.equal(runBuild(dir).exitCode, 0);
    assert.ok(read(dir, 'blog/index.html').includes('<meta property="og:image" content="https://crm.nexusaigta.ca/img/blog/fx-screen.jpg">'));
    assert.ok(!read(dir, 'blog/index.html').includes('og-default.png'));
  });

  test('the CLI renders the real launch posts in a copy of the repo', () => {
    const src = path.join(REPO, 'blog', 'posts');
    const files = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith('.json')) : [];
    if (!files.length) return;
    const dir = makeSite({ pool: null });
    fs.cpSync(path.join(REPO, 'img', 'blog'), path.join(dir, 'img', 'blog'), { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dir, 'blog', 'posts', f));
    const cli = spawnSync(process.execPath, [path.join(dir, 'scripts', 'blog', 'build.mjs')], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.equal(JSON.parse(read(dir, 'blog/posts.json')).posts.length, files.length);
    const again = spawnSync(process.execPath, [path.join(dir, 'scripts', 'blog', 'build.mjs')], { encoding: 'utf8' });
    assert.match(again.stdout, /0 file\(s\) changed/);
  });
});

// ------------------------------------------------------------------ review regressions

describe('review regressions', () => {
  const genFiles = (dir) => fs.readdirSync(path.join(dir, 'blog')).filter((f) => /\.(html|xml|json)$/.test(f)).map((f) => `blog/${f}`);

  test("an author name with $' $` $& cannot corrupt the page", () => {
    const dir = makeSite({ posts: [makePost('dollar-author', { author: "$' x $` y $& z" })] });
    const r = runBuild(dir);
    assert.equal(r.exitCode, 0, r.errors.join('\n'));
    const page = read(dir, 'blog/dollar-author.html');
    for (const re of [/<!DOCTYPE/g, /<title>/g, /<body>/g, /application\/ld\+json/g]) assert.equal((page.match(re) || []).length, 1, String(re));
    assert.ok(page.includes(`<meta name="author" content="$' x $\` y $&amp; z">`));
  });

  test('comment markers in post text cannot freeze llms.txt; the build stays repeatable', () => {
    const bad = makePost('marker-desc', { description: 'A guide to job costing for contractor crews in Ontario <!-- blog:end --> with worked examples.' });
    const pool = new Map(FIXTURE_POOL.images.map((i) => [i.id, i]));
    const v = validatePost(bad, { pool, now: new Date('2026-11-11T17:00:00Z') });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.startsWith('description') && e.includes('comment marker')));
    for (const f of ['title', 'excerpt', 'image_alt']) {
      const p = makePost('marker-x');
      p[f] = p[f] + ' -->';
      assert.equal(validatePost(p, { pool, now: new Date('2026-11-11T17:00:00Z') }).ok, false, f);
    }
    const dir = makeSite({ posts: [makePost('clean-post'), bad] });
    assert.equal(runBuild(dir).exitCode, 0);
    assert.equal(runBuild(dir).exitCode, 0, 'second build');
    writePost(dir, makePost('second-clean', { date: '2026-11-09' }));
    const r3 = runBuild(dir);
    assert.equal(r3.exitCode, 0);
    assert.ok(exists(dir, 'blog/second-clean.html'));
    const llms = read(dir, 'llms.txt');
    assert.equal((llms.match(/<!-- blog:end -->/g) || []).length, 1);
  });

  test('reserved slugs (index, feed, posts) are rejected; blog/index.html stays the index', () => {
    const pool = new Map(FIXTURE_POOL.images.map((i) => [i.id, i]));
    for (const slug of ['index', 'feed', 'posts', 'page-2']) {
      const r = validatePost(makePost(slug), { pool, now: new Date('2026-11-11T17:00:00Z') });
      assert.ok(r.errors.some((e) => e.startsWith('slug') && e.includes('reserved')), slug);
    }
    const dir = makeSite({ posts: [makePost('index'), makePost('job-costing-for-contractors')] });
    const r = runBuild(dir);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.posts, ['job-costing-for-contractors']);
    assert.ok(read(dir, 'blog/index.html').includes('<link rel="canonical" href="https://crm.nexusaigta.ca/blog/">'));
    assert.ok(!read(dir, 'sitemap.xml').includes('/blog/index.html'));
    assert.equal(runBuild(dir).written.length, 0, 'stable output');
  });

  test('body headings never take ids that js/main.js or the chrome use', () => {
    const extra = '<h2>Consent</h2><p>x</p><h2>Demo form</h2><p>y</p><h2>Form error</h2><h2>Posts</h2><h2>Main</h2>';
    const dir = makeSite({ posts: [makePost('id-clash', { extraBody: extra })] });
    assert.equal(runBuild(dir).exitCode, 0);
    const page = read(dir, 'blog/id-clash.html');
    for (const id of ['consent', 'demo-form', 'form-error', 'posts']) {
      assert.ok(!page.includes(`<h2 id="${id}">`), id);
      assert.ok(page.includes(`<h2 id="${id}-2">`), `${id}-2`);
    }
    const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique on the page');
  });

  test('huge or deeply nested bodies are rejected quickly', () => {
    const pool = new Map(FIXTURE_POOL.images.map((i) => [i.id, i]));
    const ctx = { pool, now: new Date('2026-11-11T17:00:00Z') };
    const n = 20000;
    const deep = makePost('deep-post', { body_html: '<em>'.repeat(n) + '<h2>x'.repeat(n) });
    let t = Date.now();
    const r = validatePost(deep, ctx);
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
    assert.ok(r.errors.some((e) => e.includes('nested more than')), r.errors.join('; '));
    const big = makePost('big-post', { body_html: `<p>${'a '.repeat(110000)}</p>` });
    t = Date.now();
    const r2 = validatePost(big, ctx);
    assert.ok(Date.now() - t < 1000);
    assert.ok(r2.errors.some((e) => e.includes('at most 200000')), r2.errors.join('; '));
    // unterminated tags and comments just under the size cap: the pre-checks stay linear
    for (const body of ['<a '.repeat(66000), '<a x=1 '.repeat(28000), '<!--'.repeat(49000), '<p style="x" '.repeat(15000)]) {
      t = Date.now();
      validatePost(makePost('slow-post', { body_html: body.slice(0, 199000) }), ctx);
      assert.ok(Date.now() - t < 1000, `${body.slice(0, 12)}: ${Date.now() - t} ms`);
    }
    // the attribute checks still see event handlers and src attributes
    const ev = makePost('ev-post');
    ev.body_html += '<p/onclick=alert(1)>t</p><a href="/pricing.html" src="x">y</a>';
    const er = validatePost(ev, ctx);
    assert.ok(er.errors.some((e) => e.includes('on* event')) && er.errors.some((e) => e.includes('src/action')), er.errors.join('; '));
  });

  test('unpublishing a post that others link to keeps them listed and unwraps the dead links', () => {
    const link = (s) => `<p>See <a href="/blog/${s}.html">the ${s} guide</a> and <a href="https://crm.nexusaigta.ca/blog/${s}.html">again</a>.</p>`;
    const a = makePost('post-alpha', { date: '2026-11-03', extraBody: link('post-bravo') + link('post-charlie') });
    const b = makePost('post-bravo', { date: '2026-11-04', extraBody: link('post-alpha') + link('post-charlie') });
    const c = makePost('post-charlie', { date: '2026-11-05', extraBody: link('post-alpha') + link('post-bravo') });
    const dir = makeSite({ posts: [a, b, c] });
    assert.equal(runBuild(dir).exitCode, 0);
    fs.unlinkSync(path.join(dir, 'blog', 'posts', 'post-alpha.json'));
    const r = runBuild(dir);
    assert.equal(r.exitCode, 0, r.errors.join('\n'));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.posts, ['post-charlie', 'post-bravo']);
    assert.ok(!exists(dir, 'blog/post-alpha.html'), 'the removed page is deleted');
    for (const f of ['blog/post-bravo.html', 'blog/post-charlie.html', 'blog/feed.xml', 'blog/index.html', 'sitemap.xml']) {
      assert.ok(!read(dir, f).includes('post-alpha.html'), `${f} still links to the removed post`);
    }
    assert.ok(read(dir, 'blog/post-bravo.html').includes('See the post-alpha guide and again.'), 'link text kept');
    assert.ok(read(dir, 'blog/post-bravo.html').includes('<a href="/blog/post-charlie.html">'), 'live links kept');
    assert.ok(r.warnings.some((w) => w.includes('post-alpha')));
    assert.equal(runBuild(dir).written.length, 0);
  });

  test('a renamed site page does not drop the post that links to it', () => {
    const p = makePost('links-page', { extraBody: '<p>Read <a href="/canadian-crm.html">the Canadian CRM page</a>.</p>' });
    const dir = makeSite({ posts: [p, makePost('other-page-post', { date: '2026-11-09' })] });
    assert.equal(runBuild(dir).exitCode, 0);
    fs.renameSync(path.join(dir, 'canadian-crm.html'), path.join(dir, 'canadian-crm-x.html'));
    const r = runBuild(dir);
    assert.equal(r.exitCode, 0);
    assert.ok(r.posts.includes('links-page'));
    assert.ok(read(dir, 'blog/index.html').includes('links-page.html') && read(dir, 'sitemap.xml').includes('links-page.html'));
    assert.ok(read(dir, 'blog/links-page.html').includes('Read the Canadian CRM page.'));
    assert.ok(r.warnings.some((w) => w.includes('canadian-crm.html')));
  });

  test('repo internals are not link targets; control and bidi characters are rejected', () => {
    const site = makeSite();
    const pool = new Map(FIXTURE_POOL.images.map((i) => [i.id, i]));
    for (const lenientLinks of [false, true]) {
      for (const href of ['/.git/config', '/scripts/blog/sync.mjs', '/.github/workflows/blog-publish.yml', '/blog/posts/job-costing-for-contractors.json', 'https://crm.nexusaigta.ca/.git/HEAD', '/img/blog/pool.json']) {
        const p = makePost('fixture-post');
        p.body_html += `<p><a href="${href}">x</a></p>`;
        const r = validatePost(p, { pool, root: site, now: new Date('2026-11-11T17:00:00Z'), lenientLinks });
        assert.equal(r.ok, false, `${href} lenient=${lenientLinks}`);
      }
    }
    for (const bad of ['Job costing \u0007 for contractor crews in Ontario', 'Job costing for contractor crews ‮ in Ontario']) {
      const p = makePost('fixture-post', { title: bad });
      const r = validatePost(p, { pool, now: new Date('2026-11-11T17:00:00Z') });
      assert.ok(r.errors.some((e) => e.startsWith('title')), JSON.stringify(bad));
    }
    const fa = makePost('fixture-post', { faq: [{ q: 'Is it ok?', a: 'Yes.\n\nTwo paragraphs are fine.' }] });
    assert.equal(validatePost(fa, { pool, now: new Date('2026-11-11T17:00:00Z') }).ok, true, 'blank lines in an FAQ answer are allowed');
    assert.equal(escText('a\u0001b'), 'ab');
  });

  test('no template placeholder survives in any generated file', () => {
    const dir = makeSite({ posts: [makePost('ph-one', { h2: 5 }), makePost('ph-two', { date: '2026-11-09' })] });
    assert.equal(runBuild(dir).exitCode, 0);
    for (const f of genFiles(dir)) assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(read(dir, f)), f);
    assert.ok(read(dir, 'blog/ph-one.html').includes('<h2>See your next job run on NexusCRM</h2>'));
    assert.ok(read(dir, 'blog/index.html').includes('<h2>See your business running on NexusCRM</h2>'));
  });

  test('TOC and inline CTA count only top-level h2s; the TOC collapses on phones', () => {
    const nested = '<ul><li><h2>Nested one</h2></li></ul><blockquote><h2>Nested two</h2></blockquote>';
    const html = insertBeforeThirdH2(sanitizeBody('<h2>a</h2><p>x</p><h2>b</h2>' + nested + '<p>y</p><h2>c</h2>'), '<aside>CTA</aside>');
    assert.ok(html.includes('<aside>CTA</aside>\n<h2>c</h2>'), html);
    assert.ok(!/<li><aside>/.test(html));
    const dir = makeSite({ posts: [makePost('toc-post', { h2: 4, extraBody: nested })] });
    assert.equal(runBuild(dir).exitCode, 0);
    const page = read(dir, 'blog/toc-post.html');
    const toc = page.slice(page.indexOf('<nav class="toc"'), page.indexOf('</nav>', page.indexOf('<nav class="toc"')));
    assert.ok(toc.includes('<details>') && toc.includes('<summary class="toc-title" id="toc-title">On this page <span class="toc-count">(5 sections)</span></summary>'));
    assert.ok(!toc.includes('Nested'), 'nested h2s are not listed');
    assert.ok(page.includes("window.matchMedia('(min-width: 900px)')"));
    assert.ok(page.includes('class="breadcrumbs blog-crumbs"'));
  });
});

describe('final review fixes', () => {
  test('CTA copy, AI card label, headings, tables, notes, footer date and phone links', () => {
    const table = '<table><caption>Wide table</caption><thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td><td>4</td></tr></tbody></table>';
    const a = makePost('alpha-year-end-post', { title: 'Alpha year-end checklist for contractor crews', date: '2026-11-10', extraBody: `<h2>Year-end dates</h2>${table}<p><small>Checked against the CRA on November 10, 2026.</small></p><p>Or call (437) 241-6287 today.</p>` });
    const b = makePost('beta-post', { date: '2026-10-05', image: 'fx-screen' });
    const dir = makeSite({ posts: [a, b] });
    assert.equal(runBuild(dir).exitCode, 0);
    const page = read(dir, 'blog/alpha-year-end-post.html');
    const index = read(dir, 'blog/index.html');
    for (const html of [page, index]) {
      assert.ok(html.includes('Live in about two weeks for most businesses.'));
      assert.ok(!html.includes('Live in two weeks'));
      assert.ok(!html.includes('industries/accountants.html'));
    }
    // the trial is mentioned once on a post, with the limit; the index band says so too
    assert.equal((page.match(/free for 14 days/g) || []).length, 1);
    assert.ok(page.includes('No card. Spots are limited.</p>'));
    assert.ok(index.includes('No card. Spots are limited.'));
    assert.ok(page.includes("We'll walk it through NexusCRM by NexusAI GTA,"));
    // AI label on cards whose image is AI-generated, not on screenshots
    const featured = index.slice(index.indexOf('post-card post-featured'), index.indexOf('</article>', index.indexOf('post-card post-featured')));
    assert.ok(featured.includes('<span class="post-card-ai">AI-generated illustration</span>'));
    const grid = index.slice(index.indexOf('id="posts"'));
    assert.ok(!grid.slice(0, grid.indexOf('</article>')).includes('post-card-ai'));
    // hyphenated words stay whole in display headings only
    assert.ok(page.includes('<h1>Alpha <span class="nobr">year-end</span> checklist for contractor crews</h1>'));
    assert.ok(index.includes('Alpha <span class="nobr">year-end</span> checklist'));
    assert.ok(/<h2 id="year-end-dates"><span class="nobr">Year-end<\/span> dates<\/h2>/.test(page));
    assert.ok(!ldOf(page)['@graph'][0].headline.includes('<span'));
    assert.ok(!read(dir, 'blog/feed.xml').includes('nobr'));
    // tables: hint before the wrapper, script present
    assert.ok(page.includes('<p class="tbl-hint" aria-hidden="true" hidden>Swipe the table sideways to see every column.</p><div class="tbl-scroll wide"'));
    assert.ok(page.includes("document.querySelectorAll('.tbl-scroll')"));
    assert.ok(!read(dir, 'blog/beta-post.html').includes("document.querySelectorAll('.tbl-scroll')"), 'no table, no script');
    // whole-paragraph notes and phone links
    assert.ok(page.includes('<p class="post-note"><small>Checked against the CRA on November 10, 2026.</small></p>'));
    assert.ok(page.includes('<p>Or call <a href="tel:+14372416287">(437) 241-6287</a> today.</p>'));
    // footer date follows the page; the index follows the newest post
    assert.ok(page.includes('Updated Nov 2026') && !page.includes('Updated Sep 2026'));
    assert.ok(read(dir, 'blog/beta-post.html').includes('Updated Oct 2026'));
    assert.ok(index.includes('Updated Nov 2026'));
    // index BlogPosting dates carry the offset
    assert.equal(ldOf(index)['@graph'][1].blogPost[1].datePublished, '2026-10-05T00:00:00-04:00');
    // TOC opens on desktop only when it is short
    assert.ok(page.includes("d.querySelectorAll('li').length<=8"));
    const before = snapshot(dir);
    assert.equal(runBuild(dir).written.length, 0);
    assert.deepEqual(snapshot(dir), before, 'second run changed files');
  });
});

// ------------------------------------------------------------------ sync

describe('sync', () => {
  let server;
  let base;
  const hits = {};
  const routes = {};
  before(async () => {
    server = http.createServer((req, res) => {
      const key = req.url.split('?')[0];
      hits[key] = (hits[key] || 0) + 1;
      const route = routes[key];
      if (!route) { res.writeHead(404); res.end('not found'); return; }
      route(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

  const json = (obj, status = 200) => (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  function runSync(dir, route, env = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(dir, 'scripts', 'blog', 'sync.mjs')], {
        env: { ...process.env, GITHUB_ACTIONS: '', BLOG_FEED_URL: `${base}${route}?action=feed`, BLOG_SYNC_BACKOFF_MS: '5', BLOG_SYNC_TIMEOUT_MS: '400', ...env },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
  }
  const postFiles = (dir) => fs.readdirSync(path.join(dir, 'blog', 'posts')).sort();
  const n8nPost = (slug, o) => ({ ...makePost(slug, o), source: 'n8n' });

  test('good feed: valid ready posts are written, invalid ones are not', async () => {
    const dir = makeSite({ posts: [makePost('existing-post')] });
    routes['/good'] = json({ ok: true, generated_at: '2026-11-11T12:00:00Z', ready: [makePost('new-post', { extraBody: '<p><a href="/blog/existing-post.html">x</a></p>' }), makePost('broken-post', { category: 'Nope' })], unpublish: [] });
    const r = await runSync(dir, '/good');
    assert.equal(r.code, 2, r.out); // the valid post is applied, the rejected one turns the run red
    assert.deepEqual(postFiles(dir), ['existing-post.json', 'new-post.json']);
    const written = JSON.parse(read(dir, 'blog/posts/new-post.json'));
    assert.equal(written.slug, 'new-post');
    assert.match(r.out, /broken-post failed validation/);
    // second run is a no-op
    const before = snapshot(dir);
    const r2 = await runSync(dir, '/good');
    assert.equal(r2.code, 2);
    assert.deepEqual(snapshot(dir), before);
  });

  test('caps: at most 3 posts written and 2 removed per run', async () => {
    const dir = makeSite({ posts: ['old-one', 'old-two', 'old-three', 'old-four'].map((s) => n8nPost(s)) });
    routes['/caps'] = json({ ok: true, ready: ['n-one', 'n-two', 'n-three', 'n-four', 'n-five'].map((s) => makePost(s)), unpublish: ['old-one', 'old-two', 'old-three', 'old-four'] });
    const r = await runSync(dir, '/caps');
    assert.equal(r.code, 0, r.out);
    const files = postFiles(dir);
    assert.equal(files.filter((f) => f.startsWith('n-')).length, 3);
    assert.equal(files.filter((f) => f.startsWith('old-')).length, 2);
  });

  test('path traversal and unsafe slugs are refused; removals touch only blog/posts/<slug>.json', async () => {
    const dir = makeSite({ posts: [n8nPost('victim-post')] });
    const evil = (slug) => ({ ...makePost('placeholder-post'), slug });
    routes['/traversal'] = json({
      ok: true,
      ready: [evil('../../index'), evil('../evil'), evil('a/../../b'), evil('UPPER-case'), evil('..'), evil('x'.repeat(200)), evil({ toString: 1 }), evil('/etc/passwd'), evil('ok\u0000x')],
      unpublish: ['../../index', '../index', 'index.html', '../../sitemap', 'victim-post/../../../llms', 'C:\\x', '', null, 42],
    });
    const before = snapshot(dir);
    const r = await runSync(dir, '/traversal');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(snapshot(dir), before, 'nothing written or deleted');
    routes['/unpublish'] = json({ ok: true, ready: [], unpublish: ['victim-post', 'not-there'] });
    const keepHtml = path.join(dir, 'blog', 'victim-post.html');
    fs.writeFileSync(keepHtml, 'page');
    const r2 = await runSync(dir, '/unpublish');
    assert.equal(r2.code, 0, r2.out);
    assert.ok(!exists(dir, 'blog/posts/victim-post.json'));
    assert.ok(fs.existsSync(keepHtml), 'sync never deletes pages (build does)');
    assert.ok(exists(dir, 'index.html') && exists(dir, 'sitemap.xml') && exists(dir, 'llms.txt'));
  });

  test('replace:false never overwrites; replace:true does', async () => {
    const dir = makeSite({ posts: [n8nPost('stable-post')] });
    const original = read(dir, 'blog/posts/stable-post.json');
    const changed = n8nPost('stable-post', { title: 'A completely different title for this post' });
    routes['/overwrite'] = json({ ok: true, ready: [changed], unpublish: [] });
    routes['/overwrite-false'] = json({ ok: true, ready: [{ ...changed, replace: false }], unpublish: [] });
    let r = await runSync(dir, '/overwrite');
    assert.equal(r.code, 0);
    assert.equal(read(dir, 'blog/posts/stable-post.json'), original);
    r = await runSync(dir, '/overwrite-false');
    assert.equal(read(dir, 'blog/posts/stable-post.json'), original);
    routes['/replace'] = json({ ok: true, ready: [{ ...changed, replace: true }], unpublish: [] });
    r = await runSync(dir, '/replace');
    assert.equal(r.code, 0, r.out);
    const now = JSON.parse(read(dir, 'blog/posts/stable-post.json'));
    assert.equal(now.title, 'A completely different title for this post');
    assert.ok(!('replace' in now), 'the replace flag is not stored');
  });

  test('a slug in both ready and unpublish is removed, not written', async () => {
    const dir = makeSite({ posts: [n8nPost('both-post')] });
    routes['/both'] = json({ ok: true, ready: [{ ...n8nPost('both-post'), replace: true }], unpublish: ['both-post'] });
    const r = await runSync(dir, '/both');
    assert.equal(r.code, 0, r.out);
    assert.ok(!exists(dir, 'blog/posts/both-post.json'));
  });

  test('feed errors[] are logged as warnings and do not change the exit code', async () => {
    const dir = makeSite({ posts: [makePost('existing-post')] });
    routes['/feed-errors'] = json({ ok: true, ready: [], unpublish: [], errors: ['bad-json-post', 42, { slug: 'x' }, ''] });
    const before = snapshot(dir);
    const r = await runSync(dir, '/feed-errors');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(snapshot(dir), before, 'nothing written or deleted');
    assert.match(r.out, /feed: ready row "bad-json-post" has unreadable or mismatched post_json in n8n; not published/);
    assert.equal((r.out.match(/has unreadable or mismatched post_json/g) || []).length, 1, 'only string entries are reported');
    routes['/feed-errors-bad'] = json({ ok: true, ready: [], unpublish: [], errors: 'not-a-list' });
    const r2 = await runSync(dir, '/feed-errors-bad');
    assert.equal(r2.code, 0, r2.out);
    assert.doesNotMatch(r2.out, /unreadable or mismatched/);
  });

  test('broken feeds exit 1 without touching files', async () => {
    const dir = makeSite({ posts: [makePost('safe-post')] });
    routes['/badjson'] = json('{"ok": true, "ready": [');
    routes['/notok'] = json({ ok: false, ready: [makePost('x-post')] });
    routes['/notarray'] = json({ ok: true, ready: { slug: 'x' } });
    routes['/array'] = json([makePost('x-post')]);
    routes['/oversized'] = json({ ok: true, ready: Array.from({ length: 1000 }, (_, k) => makePost(`bulk-${k}`)), unpublish: [] });
    routes['/many-removals'] = json({ ok: true, ready: [], unpublish: Array.from({ length: 500 }, (_, k) => `slug-${k}`) });
    routes['/500'] = (req, res) => { res.writeHead(500); res.end('boom'); };
    routes['/hang'] = () => { /* never answers */ };
    routes['/huge'] = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"ready":[],"pad":"' + 'x'.repeat(6 * 1024 * 1024) + '"}'); };
    const before = snapshot(dir);
    for (const route of ['/badjson', '/notok', '/notarray', '/array', '/oversized', '/many-removals', '/500', '/hang', '/huge', '/missing']) {
      const r = await runSync(dir, route);
      assert.equal(r.code, 1, `${route}: ${r.out}`);
      assert.deepEqual(snapshot(dir), before, `${route} touched files`);
    }
    assert.equal(hits['/500'], 4, 'one request plus 3 retries');
    assert.equal(hits['/hang'], 4, 'timeouts are retried');
    assert.equal(hits['/missing'], 1, 'a 404 is not retried');
    const noUrl = await runSync(dir, '/good', { BLOG_FEED_URL: '' });
    assert.equal(noUrl.code, 1);
    const plainHttp = await runSync(dir, '/good', { BLOG_FEED_URL: 'http://example.com/feed' });
    assert.equal(plainHttp.code, 1);
  });

  test('a 500 that recovers within the retries succeeds', async () => {
    const dir = makeSite();
    let n = 0;
    routes['/flaky'] = (req, res) => { if (++n < 3) { res.writeHead(503); res.end(); } else json({ ok: true, ready: [makePost('flaky-post')], unpublish: [] })(req, res); };
    const r = await runSync(dir, '/flaky');
    assert.equal(r.code, 0, r.out);
    assert.ok(exists(dir, 'blog/posts/flaky-post.json'));
  });

  test('hand-built posts cannot be replaced or removed by the feed without the override', async () => {
    const dir = makeSite({ posts: [makePost('manual-one'), makePost('manual-two', { date: '2026-11-09' })] });
    const before = snapshot(dir);
    routes['/deface'] = json({ ok: true, ready: [{ ...makePost('manual-one', { title: 'Defaced title for the manual post here' }), replace: true }], unpublish: ['manual-two'] });
    const r = await runSync(dir, '/deface');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /manual-one is a hand-built post/);
    assert.match(r.out, /manual-two is a hand-built post/);
    assert.deepEqual(snapshot(dir), before, 'manual posts untouched');
    const r2 = await runSync(dir, '/deface', { BLOG_SYNC_ALLOW_MANUAL: '1' });
    assert.equal(r2.code, 0, r2.out);
    assert.equal(JSON.parse(read(dir, 'blog/posts/manual-one.json')).title, 'Defaced title for the manual post here');
    assert.ok(!exists(dir, 'blog/posts/manual-two.json'));
  });

  test('a new post is written only if the posts it links to are written too', async () => {
    const dir = makeSite();
    // a links to b and b is invalid, so a must wait; c links to nothing new, so it is written
    routes['/chain'] = json({ ok: true, ready: [
      n8nPost('post-a', { extraBody: '<p><a href="/blog/post-b.html">b</a></p>' }),
      n8nPost('post-b', { category: 'Nope' }),
      n8nPost('post-c'),
    ], unpublish: [] });
    const r = await runSync(dir, '/chain');
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(postFiles(dir), ['post-c.json']);
    assert.match(r.out, /post-a waits for the next run/);
    // the cap does not leave a written post pointing at a deferred one
    const dir2 = makeSite();
    routes['/capchain'] = json({ ok: true, ready: [
      n8nPost('cap-one'), n8nPost('cap-two'), n8nPost('cap-three', { extraBody: '<p><a href="/blog/cap-four.html">4</a></p>' }), n8nPost('cap-four'),
    ], unpublish: [] });
    const r2 = await runSync(dir2, '/capchain');
    assert.equal(r2.code, 0, r2.out);
    const files = postFiles(dir2);
    assert.ok(!(files.includes('cap-three.json') && !files.includes('cap-four.json')), files.join(','));
    assert.ok(files.length <= 3);
  });

  test('reserved slugs are refused', async () => {
    const dir = makeSite();
    routes['/reserved'] = json({ ok: true, ready: ['index', 'feed', 'posts', 'page-2'].map((s) => n8nPost(s)), unpublish: [] });
    const r = await runSync(dir, '/reserved');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(postFiles(dir), []);
  });

  test('only post fields are written, and the source is always n8n', async () => {
    const dir = makeSite({ posts: [n8nPost('feed-owned')] });
    routes['/whitelist'] = json({ ok: true, ready: [
      { ...makePost('self-protected'), source: 'manual', token: 'deadbeefdeadbeefdeadbeefdeadbeef', check_report: { x: 1 } },
      { ...n8nPost('feed-owned', { title: 'A new title for the feed owned post here' }), source: 'manual', replace: true },
    ], unpublish: [] });
    const r = await runSync(dir, '/whitelist');
    assert.equal(r.code, 0, r.out);
    const w = JSON.parse(read(dir, 'blog/posts/self-protected.json'));
    assert.equal(w.source, 'n8n');
    assert.ok(!('token' in w) && !('check_report' in w) && !('replace' in w));
    assert.equal(w.title, makePost('self-protected').title);
    const o = JSON.parse(read(dir, 'blog/posts/feed-owned.json'));
    assert.equal(o.source, 'n8n', 'a replace cannot turn a feed post into a hand-built one');
    // so the feed can still remove both
    routes['/whitelist-remove'] = json({ ok: true, ready: [], unpublish: ['self-protected', 'feed-owned'] });
    const r2 = await runSync(dir, '/whitelist-remove');
    assert.equal(r2.code, 0, r2.out);
    assert.deepEqual(postFiles(dir), []);
  });

  test('redirects are not followed', async () => {
    const dir = makeSite();
    routes['/redirect'] = (req, res) => { res.writeHead(302, { location: `${base}/good` }); res.end(); };
    routes['/good2'] = json({ ok: true, ready: [n8nPost('redir-post')], unpublish: [] });
    const r = await runSync(dir, '/redirect');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /redirect/);
    assert.equal(hits['/redirect'], 1, 'a redirect is not retried');
    assert.deepEqual(postFiles(dir), []);
  });
});
