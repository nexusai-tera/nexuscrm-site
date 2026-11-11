#!/usr/bin/env node
// Renders the NexusCRM blog from blog/posts/*.json:
//   blog/<slug>.html, blog/index.html, blog/feed.xml, blog/posts.json,
//   and the blog blocks in sitemap.xml and llms.txt (between blog:start / blog:end markers).
// Deterministic: no clocks in the output, stable ordering, files rewritten only when they change.
// Exit 0 on success (invalid posts are skipped and reported); exit 1 when post files exist but
// none is valid (the blog is left untouched) or the site files it depends on are unusable.
// Usage: node scripts/blog/build.mjs [--root <site dir>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  SITE, SLUG_RE, DEFAULT_AUTHOR, GENERATOR_MARK, GENERATOR_COMMENT, RESERVED_IDS,
  escText, escAttr, escXml, jsonLd, cdata, sanitizeBody, addHeadingIds, wrapTables, insertBeforeThirdH2,
  absolutizeLinks, wordCount, readingMinutes, formatDateDisplay, rfc822Midnight, isoMidnight, loadPool, literalAlt,
  validatePost, extractChrome, writeIfChanged, annotate, unlinkMissingInternal,
} from './lib.mjs';

const BLOG_TITLE = 'NexusCRM Blog \u2014 Guides for Contractor Crews';
const BLOG_DESC = 'Practical guides for 4\u201315 person contractor crews in the GTA and Ontario: estimating and quoting, job costing, crew pay, seasonal planning and cash flow.';
const BLOG_OG_DESC = 'Estimating and quoting, job costing, crew pay, seasonal planning and cash flow for owner-run contractor crews. From NexusCRM by NexusAI GTA, Toronto.';
const BLOG_TW_DESC = 'Estimating, job costing, crew pay and cash flow for owner-run contractor crews in the GTA and Ontario.';
const FEED_DESC = 'Practical guides for 4\u201315 person contractor crews in the GTA and Ontario: estimating and quoting, job costing, crew pay, seasonal planning and cash flow. From NexusCRM by NexusAI GTA, Toronto.';
const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Share+Tech+Mono&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
const ORG = { '@type': 'Organization', '@id': `${SITE}/#org`, name: 'NexusAI GTA', url: 'https://www.nexusaigta.ca' };
const BLOG_REF = { '@type': 'Blog', '@id': `${SITE}/blog/#blog`, name: 'NexusCRM Blog', url: `${SITE}/blog/` };
const FEED_LIMIT = 30;
const LLMS_LIMIT = 30;

const CARD_SIZES = '(min-width: 1160px) 356px, (min-width: 960px) calc((100vw - 92px) / 3), (min-width: 640px) calc((100vw - 68px) / 2), calc(100vw - 48px)';

const CTA_BAND = `<section class="cta-band">
  <div class="wrap">
    <p class="eyebrow" style="justify-content:center">Live in about two weeks for most businesses.</p>
    <h2>{{H2}}</h2>
    <p class="lead">{{LEAD}}</p>
    <div class="btn-row" style="justify-content:center;margin-top:26px">
      <a class="btn btn-solid" href="../contact.html">Book a Demo</a>
      <a class="btn" href="{{SECOND_HREF}}">{{SECOND_LABEL}}</a>
    </div>
    <p class="note cta-contact">Book a 25-minute demo at <a href="../contact.html">crm.nexusaigta.ca/contact.html</a> or call <a href="tel:+14372416287">(437) 241-6287</a> \u00B7 info@nexusaigta.ca \u00B7 Toronto, ON</p>
  </div>
</section>`;

const INLINE_CTA = `<aside class="post-cta" aria-label="Book a demo">
  <p class="post-cta-label">See it on your own job</p>
  <p class="post-cta-title">Bring a real job to a 25-minute demo</p>
  <p>Bring a quote you sent this season. We'll walk it through NexusCRM by NexusAI GTA, from the quote to the accepted job and its live margin, and give you a straight answer on fit.</p>
  <div class="btn-row">
    <a class="btn btn-solid" href="../contact.html">Book a Demo</a>
    <a class="btn" href="../trial-guarantee.html">See the Trial Terms</a>
  </div>
  <p class="post-cta-note">After the demo, crews of 3 or more can try it free for 14 days on a real job. No card. Spots are limited.</p>
</aside>`;

const ABOUT_BOX = `<aside class="about-box" aria-label="About NexusCRM">
        <p class="about-box-label">About NexusCRM</p>
        <p>NexusCRM by NexusAI GTA is the CRM for contractor crews, built in Toronto. Talk through a site visit and the quote drafts itself; the customer accepts online, and the invoice, the job, the schedule and the crew notice happen without retyping. Pro is $425/mo CAD plus a $5,500 one-time implementation, with unlimited users. AI is built into every plan. Voice-to-quote, Bid Advisor and receipt capture start on Pro. AI Caller is a separate add-on, billed by talk minute. The AI Caller is in early access.</p>
        <p class="about-box-links"><a href="../features.html">Features</a><span class="sep" aria-hidden="true">\u00B7</span><a href="../pricing.html">Pricing</a><span class="sep" aria-hidden="true">\u00B7</span><a href="../customers.html">Customers</a><span class="sep" aria-hidden="true">\u00B7</span><a href="../contact.html">Book a 25-minute demo</a><span class="sep" aria-hidden="true">\u00B7</span><a href="tel:+14372416287">(437) 241-6287</a></p>
      </aside>`;

const AUTHOR_BOX = `<aside class="author-box" aria-label="About the author">
        <div class="author-mono" aria-hidden="true">SR</div>
        <div>
          <p class="author-name">Shaheen Rashidi</p>
          <p class="author-role">Founder of Reformity Inc. and NexusCRM</p>
          <p>Shaheen founded Reformity Inc. in 2018. NexusCRM was built inside Reformity, the founder's own GTA general contractor, which started in fencing and landscaping, and it still runs Reformity's leads, quotes, invoices, schedules and crews.</p>
          <p><a href="../about.html">More about Shaheen and Reformity</a></p>
        </div>
      </aside>`;

// Placeholder keys are upper-case letters, digits and underscores ({{H2}}). An unknown key, or
// a placeholder left over in the template, is a bug in this file: throw rather than publish it.
export const PLACEHOLDER_RE = /\{\{[A-Z0-9_]+\}\}/;
function fill(tpl, map) {
  const out = tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
    if (!Object.prototype.hasOwnProperty.call(map, k)) throw new Error(`template placeholder ${m} has no value`);
    return map[k];
  });
  for (const k of Object.keys(map)) if (!tpl.includes(`{{${k}}}`)) throw new Error(`template has no placeholder {{${k}}}`);
  if (/\{\{[^}]*\}\}/.test(tpl.replace(/\{\{[A-Z0-9_]+\}\}/g, ''))) throw new Error('template has a malformed placeholder');
  return out;
}

// Display headings: a hyphenated word ("year-end") never breaks at its hyphen. Works on
// escaped text or sanitized HTML; only text between tags is touched, never attributes.
const HYPHENATED_RE = /(?<![\p{L}\d-])[\p{L}\d]+(?:-[\p{L}\d]+)+(?![\p{L}\d-])/gu;
export function nobrHyphens(html) {
  return String(html).split(/(<[^>]*>)/).map((part, i) => (i % 2 ? part : part.replace(HYPHENATED_RE, (w) => `<span class="nobr">${w}</span>`))).join('');
}
function nobrBodyHeadings(html) {
  return String(html).replace(/(<h([23])\b[^>]*>)([\s\S]*?)(<\/h\2>)/g, (m, open, lvl, inner, close) => open + nobrHyphens(inner) + close);
}

// The sales number in article text becomes a tap-to-call link (outside existing links only).
const PHONE_RE = /\(437\) 241-6287/g;
export function linkPhone(html) {
  let inA = 0;
  return String(html).split(/(<[^>]*>)/).map((part, i) => {
    if (i % 2) { if (/^<a\b/i.test(part)) inA++; else if (/^<\/a\s*>/i.test(part)) inA = Math.max(0, inA - 1); return part; }
    return inA ? part : part.replace(PHONE_RE, '<a href="tel:+14372416287">(437) 241-6287</a>');
  }).join('');
}

// A paragraph that is one <small> note (sources, disclaimers) gets its own tighter style.
function markNotes(html) {
  return String(html).replace(/<p><small>((?:(?!<\/?small\b)[\s\S])*?)<\/small><\/p>/g, '<p class="post-note"><small>$1</small></p>');
}

// Shows the "swipe" hint above a table only while the table is wider than its box.
const TABLE_HINT_SCRIPT = '<script>(function(){var r=document.querySelectorAll(\'.tbl-scroll\');function u(){for(var i=0;i<r.length;i++){var h=r[i].previousElementSibling;if(h&&h.className===\'tbl-hint\')h.hidden=r[i].scrollWidth<=r[i].clientWidth+1;}}u();window.addEventListener(\'resize\',u);window.addEventListener(\'load\',u);})();</script>';

// "Updated Sep 2026" in the inherited footer reflects the page's own date.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function footerDated(footer, ymd) {
  if (!ymd) return footer;
  const [y, m] = ymd.split('-').map(Number);
  return footer.replace(/Updated [A-Z][a-z]{2} \d{4}/g, `Updated ${MON[m - 1]} ${y}`);
}

function head({ title, description, canonical, ogType, ogTitle, ogDesc, twTitle, twDesc, image, robots, extraMeta = '', cssHref, ld }) {
  const img = image
    ? `<meta property="og:image" content="${escAttr(image.url)}">
<meta property="og:image:width" content="${image.width}">
<meta property="og:image:height" content="${image.height}">
<meta property="og:image:alt" content="${escAttr(image.alt)}">
`
    : '';
  const twImg = image ? `<meta name="twitter:image" content="${escAttr(image.url)}">\n` : '';
  return `<!DOCTYPE html>
${GENERATOR_COMMENT}
<html lang="en-CA">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escText(title)}</title>
<meta name="description" content="${escAttr(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${escAttr(ogTitle)}">
<meta property="og:description" content="${escAttr(ogDesc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="NexusCRM by NexusAI GTA">
<meta property="og:locale" content="en_CA">
${img}${extraMeta}${twImg}<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${escAttr(twTitle)}">
<meta name="twitter:description" content="${escAttr(twDesc)}">
<meta name="robots" content="${robots}">
${FONTS}
<link rel="icon" type="image/svg+xml" href="../favicon.svg">
<link rel="stylesheet" href="${cssHref}">
<link rel="alternate" type="application/rss+xml" title="NexusCRM Blog" href="${SITE}/blog/feed.xml">
<script type="application/ld+json">
${jsonLd(ld)}
</script>
</head>
<body>
`;
}

function tail(chrome, ymd) {
  return `${footerDated(chrome.footer, ymd)}

<script src="../js/main.js"></script>
${chrome.beacon}
</body>
</html>
`;
}

function cardHtml(p, { featured = false, headingTag = 'h3', showAuthor = false } = {}) {
  const img = featured
    ? `<img src="..${escAttr(p.img.src)}" srcset="..${escAttr(p.img.card)} 800w, ..${escAttr(p.img.src)} 1600w" sizes="(min-width: 1160px) 595px, (min-width: 880px) calc((100vw - 48px) * 0.535), calc(100vw - 48px)" width="1600" height="840" alt="" fetchpriority="high" decoding="async">`
    : `<img src="..${escAttr(p.img.card)}" srcset="..${escAttr(p.img.card)} 800w, ..${escAttr(p.img.src)} 1600w" sizes="${CARD_SIZES}" width="800" height="420" alt="" loading="lazy" decoding="async">`;
  const author = showAuthor ? `<span>By ${escText(p.author)}</span>` : '';
  return `<article class="post-card${featured ? ' post-featured' : ''}">
        <div class="post-card-media">${img}${p.img.ai_generated ? '<span class="post-card-ai">AI-generated illustration</span>' : ''}</div>
        <div class="post-card-body">
          <p class="post-card-cat"><span class="pill">${escText(p.category)}</span></p>
          <${headingTag} class="post-card-title"><a href="${p.slug}.html">${nobrHyphens(escText(p.title))}</a></${headingTag}>
          <p class="post-card-excerpt">${escText(p.excerpt)}</p>
          <p class="post-meta">${author}<time datetime="${p.date}">${formatDateDisplay(p.date)}</time><span>${p.readMin} min read</span></p>
        </div>
      </article>`;
}

function faqParagraphs(a) {
  return String(a).trim().split(/\n\s*\n/).map((s) => `<p>${escText(s.replace(/\s+/g, ' ').trim())}</p>`).join('');
}

function relatedFor(p, all) {
  const others = all.filter((o) => o.slug !== p.slug);
  const picked = [];
  const add = (list) => { for (const o of list) if (picked.length < 3 && !picked.includes(o)) picked.push(o); };
  add(others.filter((o) => o.category === p.category));
  add(others.filter((o) => o.tags.some((t) => p.tags.includes(t))));
  add(others);
  return picked;
}

function renderPost(p, all, chrome, cssHref) {
  const url = `${SITE}/blog/${p.slug}.html`;
  const tagsMeta = p.tags.map((t) => `<meta property="article:tag" content="${escAttr(t)}">\n`).join('');
  const extraMeta = `<meta name="author" content="${escAttr(p.author)}">
<meta property="article:published_time" content="${isoMidnight(p.date)}">
<meta property="article:modified_time" content="${isoMidnight(p.updated || p.date)}">
<meta property="article:section" content="${escAttr(p.category)}">
${tagsMeta}`;
  const isFounder = p.author === 'Shaheen Rashidi';
  const authorLd = isFounder
    ? { '@type': 'Person', '@id': `${SITE}/about.html#shaheen-rashidi`, name: 'Shaheen Rashidi', jobTitle: 'Founder', url: `${SITE}/about.html`, affiliation: { '@type': 'Organization', name: 'Reformity Inc.', url: 'https://reformityinc.com' } }
    : { '@type': 'Organization', name: p.author, url: `${SITE}/about.html` };
  const graph = [
    {
      '@type': 'BlogPosting',
      '@id': `${url}#post`,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      url,
      headline: p.title,
      description: p.description,
      image: [p.img.url],
      datePublished: isoMidnight(p.date),
      dateModified: isoMidnight(p.updated || p.date),
      inLanguage: 'en-CA',
      articleSection: p.category,
      keywords: p.tags.join(', '),
      wordCount: p.words,
      timeRequired: `PT${p.readMin}M`,
      author: authorLd,
      publisher: ORG,
      isPartOf: BLOG_REF,
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumbs`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog/` },
        { '@type': 'ListItem', position: 3, name: p.title, item: url },
      ],
    },
  ];
  if (p.faq.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: p.faq.map((f) => ({ '@type': 'Question', name: f.q.replace(/\s+/g, ' ').trim(), acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/\s+/g, ' ').trim() } })),
    });
  }
  const ld = { '@context': 'https://schema.org', '@graph': graph };

  const updated = p.updated && p.updated !== p.date ? `<span>Updated <time datetime="${p.updated}">${formatDateDisplay(p.updated)}</time></span>` : '';
  const caption = p.img.ai_generated ? '\n        <figcaption>AI-generated illustration</figcaption>' : typeof p.img.caption === 'string' && p.img.caption.trim() ? `\n        <figcaption>${escText(p.img.caption.trim())}</figcaption>` : '';
  // TOC: top-level h2s only. It is collapsed on phones (a long list would push the article a
  // screen and a half down) and opened by the inline script on screens 900px and wider when it
  // has 8 entries or fewer (a longer open list pushes the article below the fold on laptops).
  const h2s = p.headings.filter((h) => h.level === 2 && h.top);
  const tocCount = h2s.length + (p.faq.length ? 1 : 0);
  const toc = h2s.length >= 4
    ? `
      <nav class="toc" aria-labelledby="toc-title">
        <details>
          <summary class="toc-title" id="toc-title">On this page <span class="toc-count">(${tocCount} sections)</span></summary>
          <ol>
${h2s.map((h) => `          <li><a href="#${h.id}">${escText(h.text)}</a></li>`).join('\n')}${p.faq.length ? '\n          <li><a href="#faq">Questions, answered</a></li>' : ''}
          </ol>
        </details>
      </nav>
      <script>(function(){var n=document.currentScript.previousElementSibling,d=n&&n.querySelector('details');if(d&&d.querySelectorAll('li').length<=8&&window.matchMedia&&window.matchMedia('(min-width: 900px)').matches)d.open=true;})();</script>
`
    : '';
  const faq = p.faq.length
    ? `
      <section class="post-faq" id="faq" aria-labelledby="faq-title">
        <h2 id="faq-title">Questions, answered</h2>
        <div class="faq">
${p.faq.map((f) => `          <details>
            <summary>${escText(f.q.replace(/\s+/g, ' ').trim())}</summary>
            <div class="a">${faqParagraphs(f.a)}</div>
          </details>`).join('\n')}
        </div>
      </section>
`
    : '';
  const related = relatedFor(p, all);
  const relatedHtml = related.length
    ? `
<section class="band related" aria-labelledby="related-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Keep reading</p>
      <h2 id="related-title">More from the blog</h2>
    </div>
    <div class="blog-grid">
      ${related.map((o) => cardHtml(o)).join('\n      ')}
    </div>
    <p class="note related-more"><a href="../blog/">All posts</a><span class="sep" aria-hidden="true">\u00B7</span><a href="feed.xml">RSS feed</a></p>
  </div>
</section>
`
    : '';

  return head({
    title: `${p.seoTitle || p.title} | NexusCRM`,
    description: p.description,
    canonical: url,
    ogType: 'article',
    ogTitle: p.title,
    ogDesc: p.description,
    twTitle: p.title,
    twDesc: p.description,
    image: { url: p.img.url, width: p.img.width, height: p.img.height, alt: p.alt },
    robots: 'index, follow, max-snippet:-1, max-image-preview:large',
    extraMeta,
    cssHref,
    ld,
  }) + `
${chrome.nav.replace(' aria-current="page"', ' aria-current="true"')}

<div class="wrap">
  <div class="post-col">
    <nav class="breadcrumbs blog-crumbs" aria-label="Breadcrumb"><a href="../index.html">Home</a> / <a href="../blog/">Blog</a> / <span aria-current="page">${escText(p.title)}</span></nav>
  </div>
</div>

<main id="main">

<article class="post">
  <header class="hero post-hero">
    <div class="wrap">
      <div class="post-col">
        <p class="eyebrow">${escText(p.category)}</p>
        <h1>${nobrHyphens(escText(p.title))}</h1>
        <p class="lead">${escText(p.description)}</p>
        <p class="post-meta"><span>By <a href="../about.html">${escText(p.author)}</a></span><time datetime="${p.date}">${formatDateDisplay(p.date)}</time><span>${p.readMin} min read</span>${updated}</p>
      </div>
    </div>
  </header>

  <div class="wrap post-body">
    <div class="post-col">

      <figure class="post-cover wide">
        <img src="..${escAttr(p.img.src)}" srcset="..${escAttr(p.img.card)} 800w, ..${escAttr(p.img.src)} 1600w" sizes="(min-width: 900px) 760px, calc(100vw - 48px)" width="1600" height="840" alt="${escAttr(p.alt)}" fetchpriority="high" decoding="async">${caption}
      </figure>
${toc}
      <div class="prose">
${p.pageBody}
      </div>
${p.pageBody.includes('class="tbl-hint"') ? `      ${TABLE_HINT_SCRIPT}\n` : ''}${faq}
      ${isFounder ? AUTHOR_BOX + '\n\n      ' : ''}${ABOUT_BOX}

    </div>
  </div>
</article>
${relatedHtml}
${fill(CTA_BAND, {
  H2: 'See your next job run on NexusCRM',
  LEAD: "Book a 25-minute demo. Bring a job you quoted this season and we'll walk it through NexusCRM, from the quote to acceptance to the job's margin, then give you a straight answer on fit.",
  SECOND_HREF: '../pricing.html',
  SECOND_LABEL: 'See Pricing',
})}

</main>

${tail(chrome, p.updated || p.date)}`;
}

function renderIndex(posts, chrome, cssHref, ogImage) {
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${SITE}/blog/#webpage`,
        url: `${SITE}/blog/`,
        name: BLOG_TITLE,
        description: BLOG_DESC,
        inLanguage: 'en-CA',
        isPartOf: { '@id': `${SITE}/#site` },
        breadcrumb: { '@id': `${SITE}/blog/#breadcrumbs` },
        mainEntity: { '@id': `${SITE}/blog/#blog` },
      },
      {
        '@type': 'Blog',
        '@id': `${SITE}/blog/#blog`,
        name: 'NexusCRM Blog',
        url: `${SITE}/blog/`,
        inLanguage: 'en-CA',
        publisher: ORG,
        blogPost: posts.map((p) => ({ '@type': 'BlogPosting', '@id': `${SITE}/blog/${p.slug}.html#post`, headline: p.title, url: `${SITE}/blog/${p.slug}.html`, datePublished: isoMidnight(p.date), image: p.img.url })),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${SITE}/blog/#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog/` },
        ],
      },
    ],
  };
  const [first, ...rest] = posts;
  const featured = first
    ? `<section class="tight" id="featured" aria-label="Latest post">
  <div class="wrap">
    ${cardHtml(first, { featured: true, headingTag: 'h2', showAuthor: true })}
  </div>
</section>
`
    : `<section class="tight" id="featured" aria-label="Latest post">
  <div class="wrap">
    <p class="lead blog-empty">The first posts are on the way.</p>
  </div>
</section>
`;
  const grid = rest.length
    ? `
<section class="band" id="posts" aria-labelledby="posts-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">All posts</p>
      <h2 id="posts-title">Latest from the blog</h2>
    </div>
    <div class="blog-grid">
      ${rest.map((p) => cardHtml(p)).join('\n      ')}
    </div>
  </div>
</section>
`
    : '';
  return head({
    title: BLOG_TITLE,
    description: BLOG_DESC,
    canonical: `${SITE}/blog/`,
    ogType: 'website',
    ogTitle: BLOG_TITLE,
    ogDesc: BLOG_OG_DESC,
    twTitle: BLOG_TITLE,
    twDesc: BLOG_TW_DESC,
    image: ogImage,
    robots: posts.length ? 'index, follow, max-snippet:-1, max-image-preview:large' : 'noindex, follow',
    cssHref,
    ld,
  }) + `
${chrome.nav}

<div class="wrap">
  <nav class="breadcrumbs blog-crumbs" aria-label="Breadcrumb"><a href="../index.html">Home</a> / <span aria-current="page">Blog</span></nav>
</div>

<main id="main">

<header class="hero blog-hero">
  <div class="wrap">
    <p class="eyebrow">The NexusCRM blog \u00B7 Built in Toronto</p>
    <h1>Guides for <span>contractor crews</span></h1>
    <p class="lead">Estimating and quoting, job costing, crew pay, seasonal planning and cash flow, written for owner-run crews in the GTA and across Ontario by NexusAI GTA, the Toronto team that builds NexusCRM.</p>
    <p class="note blog-note">Follow new posts by <a href="feed.xml">RSS</a><span class="sep" aria-hidden="true">\u00B7</span><a href="../contact.html">Book a 25-minute demo</a></p>
  </div>
</header>

${featured}${grid}
<section class="tight" id="more-on-site">
  <div class="wrap center">
    <p class="eyebrow" style="justify-content:center">Also on the site</p>
    <div class="btn-row" style="justify-content:center">
      <a class="btn btn-ghost" href="../best-crm-for-contractors-canada.html">Best Contractor CRMs</a>
      <a class="btn btn-ghost" href="../customers.html">Customer Case Study</a>
      <a class="btn btn-ghost" href="../pricing.html">Pricing</a>
      <a class="btn btn-ghost" href="../trial-guarantee.html">Trial &amp; Guarantee</a>
    </div>
  </div>
</section>

${fill(CTA_BAND, {
  H2: 'See your business running on NexusCRM',
  LEAD: "Book a 25-minute demo. We'll walk your actual workflow, lead to quote to money in the bank, and give you a straight answer on fit. After the demo, crews of 3 or more can try it free for 14 days on a real job. No card. Spots are limited.",
  SECOND_HREF: '../trial-guarantee.html',
  SECOND_LABEL: 'See the Trial Terms',
})}

</main>

${tail(chrome, posts.reduce((m, p) => ((p.updated || p.date) > m ? p.updated || p.date : m), ''))}`;
}

function renderFeed(posts) {
  const items = posts.slice(0, FEED_LIMIT);
  const newest = posts.reduce((m, p) => ((p.updated || p.date) > m ? p.updated || p.date : m), '');
  const itemXml = items.map((p) => {
    const url = `${SITE}/blog/${p.slug}.html`;
    const enclosure = p.imgBytes ? `\n      <enclosure url="${escXml(p.img.url)}" length="${p.imgBytes}" type="image/jpeg"/>` : '';
    return `    <item>
      <title>${escXml(p.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${rfc822Midnight(p.date)}</pubDate>
      <dc:creator>${escXml(p.author)}</dc:creator>
      <category>${escXml(p.category)}</category>
      <description>${escXml(p.description)}</description>
      <content:encoded>${cdata(p.feedBody)}</content:encoded>${enclosure}
    </item>
`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${GENERATOR_MARK}; do not edit by hand -->
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>NexusCRM Blog</title>
    <link>${SITE}/blog/</link>
    <atom:link href="${SITE}/blog/feed.xml" rel="self" type="application/rss+xml"/>
    <description>${escXml(FEED_DESC)}</description>
    <language>en-ca</language>
    <copyright>\u00A9 2026 NexusAI GTA</copyright>
    <managingEditor>info@nexusaigta.ca (NexusAI GTA)</managingEditor>
    <webMaster>info@nexusaigta.ca (NexusAI GTA)</webMaster>
${newest ? `    <lastBuildDate>${rfc822Midnight(newest)}</lastBuildDate>\n` : ''}    <docs>https://www.rssboard.org/rss-specification</docs>
    <ttl>180</ttl>
${itemXml}  </channel>
</rss>
`;
}

function renderManifest(posts) {
  const list = posts.map((p) => ({
    slug: p.slug,
    url: `${SITE}/blog/${p.slug}.html`,
    title: p.title,
    description: p.description,
    excerpt: p.excerpt,
    category: p.category,
    tags: p.tags,
    date: p.date,
    updated: p.updated || null,
    image: p.image,
    image_url: p.img.url,
    read_minutes: p.readMin,
    word_count: p.words,
    primary_keyword: p.primaryKeyword || null,
  }));
  return JSON.stringify({ posts: list }, null, 2) + '\n';
}

// Replaces (or creates) the block between the markers. Returns { text } or { error }.
function replaceBlock(text, startRe, endMarker, block, insert) {
  const s = text.search(startRe);
  const e = text.indexOf(endMarker);
  if (s === -1 && e === -1) return { text: insert(text, block) };
  if (s === -1 || e === -1 || e < s) return { error: 'blog markers are unbalanced' };
  if (text.indexOf(endMarker, e + 1) !== -1 || text.slice(s + 1).search(startRe) !== -1) return { error: 'blog markers appear more than once' };
  const lineStart = text.lastIndexOf('\n', s) + 1;
  const end = e + endMarker.length;
  return { text: text.slice(0, lineStart) + block + text.slice(end) };
}

function sitemapBlock(posts) {
  const rows = [];
  if (posts.length) {
    const newest = posts.reduce((m, p) => ((p.updated || p.date) > m ? p.updated || p.date : m), '');
    rows.push(`  <url><loc>${SITE}/blog/</loc><lastmod>${newest}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
    for (const p of posts) rows.push(`  <url><loc>${SITE}/blog/${p.slug}.html</loc><lastmod>${p.updated || p.date}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`);
  }
  return ['  <!-- blog:start generated by scripts/blog/build.mjs; do not edit by hand -->', ...rows, '  <!-- blog:end -->'].join('\n');
}

function llmsBlock(posts) {
  const lines = ['<!-- blog:start -->'];
  if (posts.length) {
    lines.push('## Blog', '');
    lines.push(`- [NexusCRM Blog](${SITE}/blog/): guides for contractor crews on estimating and quoting, job costing, crew pay, seasonal planning and cash flow; RSS feed: ${SITE}/blog/feed.xml`);
    // post text never carries a comment marker into the file (validatePost rejects them too):
    // a stray <!-- blog:end --> would make every later build refuse llms.txt
    const flat = (s) => s.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim();
    for (const p of posts.slice(0, LLMS_LIMIT)) {
      const t = flat(p.title).replace(/([[\]])/g, '\\$1');
      lines.push(`- [${t}](${SITE}/blog/${p.slug}.html): ${flat(p.description)} (${p.date})`);
    }
  }
  lines.push('<!-- blog:end -->');
  return lines.join('\n');
}

export function build({ root, now = new Date(), log = annotate } = {}) {
  const result = { exitCode: 0, written: [], removed: [], errors: [], warnings: [], posts: [] };
  const fail = (msg, file) => { result.errors.push(msg); log('error', msg, file); };
  const rel = (f) => path.relative(root, f);

  // site files the build depends on
  let indexHtml;
  try { indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8'); } catch (e) { fail(`cannot read index.html: ${e.message}`); result.exitCode = 1; return result; }
  const chrome = extractChrome(indexHtml, '../');
  if (chrome.errors.length) { chrome.errors.forEach((m) => fail(m, 'index.html')); result.exitCode = 1; return result; }
  let cssHref = '../css/style.css';
  try { cssHref += '?v=' + crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'css', 'style.css'))).digest('hex').slice(0, 8); } catch { /* no stylesheet: plain link */ }
  let sitemap, llms;
  try { sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8'); } catch (e) { fail(`cannot read sitemap.xml: ${e.message}`); result.exitCode = 1; return result; }
  try { llms = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8'); } catch (e) { fail(`cannot read llms.txt: ${e.message}`); result.exitCode = 1; return result; }

  const pool = loadPool(root);
  const blogDir = path.join(root, 'blog');
  const postsDir = path.join(blogDir, 'posts');
  let files = [];
  try { files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.json')).sort(); } catch { files = []; }
  if (files.length && pool.errors.length && !pool.images.size) { pool.errors.forEach((m) => fail(m, 'img/blog/pool.json')); result.exitCode = 1; return result; }
  pool.errors.forEach((m) => { result.warnings.push(m); log('warning', m, 'img/blog/pool.json'); });

  // parse
  const candidates = [];
  const sourceSlugs = new Set();
  for (const f of files) {
    const fileSlug = f.slice(0, -5);
    const relFile = `blog/posts/${f}`;
    if (!SLUG_RE.test(fileSlug)) { fail(`${relFile}: file name is not a valid slug; skipped`, relFile); continue; }
    sourceSlugs.add(fileSlug);
    let post;
    try { post = JSON.parse(fs.readFileSync(path.join(postsDir, f), 'utf8')); } catch (e) { fail(`${relFile}: invalid JSON (${e.message}); skipped`, relFile); continue; }
    candidates.push({ fileSlug, relFile, post });
  }

  // pages of posts whose source file still exists but is invalid are kept as they are
  const existingPages = new Set();
  try { for (const f of fs.readdirSync(blogDir)) if (f.endsWith('.html') && f !== 'index.html') existingPages.add(f.slice(0, -5)); } catch { /* no blog dir yet */ }

  // validate (one pass). Links to a post or page that is missing are warnings here, not errors:
  // the link is unwrapped at render time, so unpublishing a post (or renaming a site page)
  // never takes down the posts that link to it.
  const allSlugs = new Set(candidates.map((c) => c.fileSlug));
  const report = new Map(candidates.map((c) => [c.fileSlug, validatePost(c.post, { pool: pool.images, root, knownSlugs: allSlugs, fileSlug: c.fileSlug, now, lenientLinks: true })]));
  const valid = candidates.filter((c) => report.get(c.fileSlug).ok);
  for (const c of candidates) {
    const r = report.get(c.fileSlug);
    // missing-link warnings are reported once, when the link is unwrapped below
    r.warnings.filter((w) => !w.endsWith('the link is removed and its text kept')).forEach((w) => { result.warnings.push(`${c.relFile}: ${w}`); log('warning', w, c.relFile); });
    if (!r.ok) fail(`${c.relFile} skipped: ${r.errors.join('; ')}`, c.relFile);
  }
  if (files.length && !valid.length) {
    fail(`none of the ${files.length} post file(s) is valid; nothing was changed`);
    result.exitCode = 1;
    return result;
  }
  // slugs that will have a page after this build: the rendered posts, plus kept pages of
  // invalid sources
  const liveSlugs = new Set([...valid.map((c) => c.fileSlug), ...[...sourceSlugs].filter((s) => existingPages.has(s))]);
  const reservedIds = [...new Set([...RESERVED_IDS, ...chrome.ids])];

  // prepare
  const posts = valid.map(({ post, relFile, fileSlug }) => {
    const entry = pool.images.get(post.image);
    const clean = report.get(fileSlug).clean ?? sanitizeBody(post.body_html);
    const { html: linked, unlinked } = unlinkMissingInternal(clean, { root, liveSlugs });
    for (const h of unlinked) { const m = `link to ${h} removed (the target is not on the site); its text is kept`; result.warnings.push(`${relFile}: ${m}`); log('warning', m, relFile); }
    const { html: withIds, headings } = addHeadingIds(linked, reservedIds);
    const words = wordCount(clean);
    let imgBytes = 0;
    try { imgBytes = fs.statSync(path.join(root, entry.src.replace(/^\//, ''))).size; } catch { /* file not present */ }
    return {
      slug: post.slug,
      title: post.title.trim(),
      seoTitle: typeof post.seo_title === 'string' ? post.seo_title.trim() : '',
      description: post.description.trim(),
      excerpt: (typeof post.excerpt === 'string' && post.excerpt.trim() ? post.excerpt : post.description).trim(),
      category: post.category,
      tags: post.tags.slice(),
      date: post.date,
      updated: typeof post.updated === 'string' && post.updated ? post.updated : '',
      author: post.author && typeof post.author.name === 'string' && post.author.name.trim() ? post.author.name.trim() : DEFAULT_AUTHOR,
      image: post.image,
      img: { ...entry, url: SITE + entry.src },
      imgBytes,
      alt: literalAlt(post.image_alt) || literalAlt(entry.alt),
      faq: Array.isArray(post.faq) ? post.faq : [],
      primaryKeyword: typeof post.primary_keyword === 'string' ? post.primary_keyword : '',
      headings,
      words,
      readMin: readingMinutes(words),
      pageBody: insertBeforeThirdH2(wrapTables(markNotes(nobrBodyHeadings(linkPhone(withIds)))), INLINE_CTA),
      feedBody: absolutizeLinks(linkPhone(withIds)),
    };
  });
  posts.sort((a, b) => (a.date === b.date ? (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) : a.date < b.date ? 1 : -1));
  result.posts = posts.map((p) => p.slug);

  // sitemap and llms.txt blocks (computed before writing anything)
  const sm = replaceBlock(sitemap, /<!-- blog:start/, '<!-- blog:end -->', sitemapBlock(posts), (t, b) => {
    const i = t.lastIndexOf('</urlset>');
    return i === -1 ? null : t.slice(0, i) + b + '\n' + t.slice(i);
  });
  if (sm.error || sm.text == null) { fail(`sitemap.xml: ${sm.error || '</urlset> not found'}`, 'sitemap.xml'); result.exitCode = 1; return result; }
  const lt = replaceBlock(llms, /<!-- blog:start -->/, '<!-- blog:end -->', llmsBlock(posts), (t, b) => t.replace(/\s*$/, '\n') + '\n' + b + '\n');
  if (lt.error) { fail(`llms.txt: ${lt.error}`, 'llms.txt'); result.exitCode = 1; return result; }

  // og:image for the index: the brand cover if it is in the pool, else the newest post's image
  const cover = pool.images.get('cover-nexuscrm-youtube-banner');
  const ogImage = cover
    ? { url: SITE + cover.src, width: cover.width, height: cover.height, alt: literalAlt(cover.alt) || 'NexusCRM' }
    : posts[0] ? { url: posts[0].img.url, width: posts[0].img.width, height: posts[0].img.height, alt: posts[0].alt } : null;

  // render everything before writing anything (a template bug stops the build cleanly)
  const outputs = [];
  try {
    for (const p of posts) outputs.push([path.join(blogDir, `${p.slug}.html`), renderPost(p, posts, chrome, cssHref)]);
    outputs.push([path.join(blogDir, 'index.html'), renderIndex(posts, chrome, cssHref, ogImage)]);
    outputs.push([path.join(blogDir, 'feed.xml'), renderFeed(posts)]);
    outputs.push([path.join(blogDir, 'posts.json'), renderManifest(posts)]);
  } catch (e) {
    fail(`rendering failed: ${e.message}; nothing was changed`);
    result.exitCode = 1;
    return result;
  }
  outputs.push([path.join(root, 'sitemap.xml'), sm.text], [path.join(root, 'llms.txt'), lt.text]);

  // write
  const out = (file, content) => { if (writeIfChanged(file, content)) result.written.push(rel(file)); };
  for (const [file, content] of outputs) out(file, content);

  // orphans: generated post pages whose source file is gone
  const rendered = new Set(posts.map((p) => p.slug));
  for (const slug of [...existingPages].sort()) {
    if (rendered.has(slug) || sourceSlugs.has(slug)) continue;
    const f = path.join(blogDir, `${slug}.html`);
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (text.includes(GENERATOR_MARK)) { fs.unlinkSync(f); result.removed.push(rel(f)); }
  }

  console.log(`blog build: ${posts.length} post(s) rendered; ${result.written.length} file(s) changed${result.removed.length ? `; removed ${result.removed.join(', ')}` : ''}${result.errors.length ? `; ${result.errors.length} problem(s) reported above` : ''}`);
  return result;
}

const here = fileURLToPath(import.meta.url);
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(here); } catch { return false; } })();
if (isMain) {
  const k = process.argv.indexOf('--root');
  const root = k !== -1 && process.argv[k + 1] ? path.resolve(process.argv[k + 1]) : path.resolve(path.dirname(here), '..', '..');
  const r = build({ root });
  process.exitCode = r.exitCode;
}
