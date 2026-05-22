const fs    = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS   = require("rss");

const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";
const OUTPUT_FILE     = "./feeds/feed.xml";
const MAX_ITEMS       = 500;

fs.mkdirSync("./feeds", { recursive: true });

// ===== FLARESOLVERR =====
async function fetchWithFlareSolverr(url) {
  console.log(`Fetching ${url} via FlareSolverr...`);
  const response = await axios.post(
    `${flareSolverrURL}/v1`,
    { cmd: "request.get", url, maxTimeout: 60_000 },
    { headers: { "Content-Type": "application/json" }, timeout: 65_000 }
  );
  if (response.data?.solution) {
    console.log("✅ FlareSolverr OK");
    return response.data.solution.response;
  }
  throw new Error("FlareSolverr did not return a solution");
}

// ===== SCRAPER: TIMES OF BANGLADESH =====
// Works for:
//   Category page : https://tob.news/category/opinion/
//   Author pages  : https://tob.news/author/navid/
//                   https://tob.news/author/timesopinion/
//
// Article container : article.l-post.list-post
// Title + link      : h3.is-title.post-title a[href]
// Image             : img[data-src] inside div.media  (lazy-loaded; src is SVG placeholder)
// Date              : time.post-date[datetime]  →  ISO 8601 with +06:00 offset
// Author            : span.meta-item.post-author a
// Excerpt           : div.excerpt p

const TOB_BASE = "https://tob.news";

function scrapeTOB(html, seen, category) {
  const $     = cheerio.load(html);
  const items = [];

  $("article.l-post.list-post").each((_, el) => {
    const $el = $(el);

    // ── Link ──────────────────────────────────────────────────────────────────
    const $titleAnchor = $el.find("h3.is-title.post-title a, h2.is-title.post-title a").first();
    const href = ($titleAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : TOB_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    // ── Title ─────────────────────────────────────────────────────────────────
    const title = $titleAnchor.text().trim();
    if (!title) return;

    // ── Image (data-src on lazy-loaded img) ───────────────────────────────────
    const $img  = $el.find("div.media img").first();
    const image = ($img.attr("data-src") || $img.attr("src") || "").trim() || null;
    // Discard the SVG placeholder base64 blobs
    const finalImage = (image && !image.startsWith("data:")) ? image : null;

    // ── Date ──────────────────────────────────────────────────────────────────
    const datetime = ($el.find("time.post-date").first().attr("datetime") || "").trim();
    const date     = datetime ? new Date(datetime) : new Date();

    // ── Author ────────────────────────────────────────────────────────────────
    const author = $el.find("span.meta-item.post-author a").first().text().trim() || "";

    // ── Excerpt ───────────────────────────────────────────────────────────────
    const excerpt = $el.find("div.excerpt p").first().text().trim();

    items.push({
      title,
      link,
      description: excerpt,
      image:       finalImage,
      date,
      category,
      author,
    });
  });

  console.log(`  [TOB/${category}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: THE BUSINESS STANDARD – Features & Thoughts =====
// Works for:
//   https://www.tbsnews.net/features
//   https://www.tbsnews.net/thoughts
//
// Framework     : Drupal (custom theme "sloth")
// Article cards : div.card inside div.view-content.row
// Link + Title  : h2.card-title a  OR  h3.card-title a  (relative href)
// Image         : img[data-src] inside <picture> inside div.card-image
//                 (lazysizes; src is SVG placeholder — discarded)
// Excerpt       : p.card-intro  (present only on the big lead card)
// Date          : Not in listing HTML → new Date() fallback
// Category      : Derived from URL path:
//                   /thoughts/...              → "Thoughts"
//                   /features/panorama/...     → "Panorama"
//                   /features/big-picture/...  → "The Big Picture"
//                   /features/<other>/...      → title-cased sub-label
//                   /features/<slug> (no sub)  → "Features"

const TBS_BASE = "https://www.tbsnews.net";

const TBS_SUBCAT_MAP = {
  "panorama":          "Panorama",
  "big-picture":       "The Big Picture",
  "pursuit":           "Pursuit",
  "habitat":           "Habitat",
  "tales-from-the-edge": "Tales from the Edge",
  "mode":              "Mode",
  "explorer":          "Explorer",
  "brands":            "Brands",
  "focus":             "In Focus",
  "book-review":       "Book Review",
  "food":              "Food",
  "luxury":            "Luxury",
  "wheels":            "Wheels",
  "humour":            "Humour",
  "game-reviews":      "Game Reviews",
  "wealth":            "Wealth",
};

function getTBSCategory(href) {
  if (href.startsWith("/thoughts")) return "Thoughts";
  const m = href.match(/^\/features\/([^/]+)\//);
  if (m) return TBS_SUBCAT_MAP[m[1]] || "Features";
  return "Features";
}

function scrapeTBS(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  // Scope to the Drupal view content block to avoid sidebar cards
  const $view = $("div.view-content");

  $view.find("div.card").each((_, el) => {
    const $el = $(el);

    // ── Link (from card-image anchor; identical to title anchor) ─────────────
    const $imgAnchor = $el.find("div.card-image a").first();
    const rawHref    = ($imgAnchor.attr("href") || "").trim();
    if (!rawHref) return;

    // Only ingest Features and Thoughts articles
    if (!rawHref.startsWith("/features") && !rawHref.startsWith("/thoughts")) return;

    const link = rawHref.startsWith("http") ? rawHref : TBS_BASE + rawHref;
    if (seen.has(link)) return;
    seen.add(link);

    // ── Title ─────────────────────────────────────────────────────────────────
    const $titleAnchor = $el.find("h2.card-title a, h3.card-title a").first();
    const title        = $titleAnchor.text().trim();
    if (!title) return;

    // ── Image ─────────────────────────────────────────────────────────────────
    const $img   = $el.find("div.card-image img").first();
    const imgSrc = ($img.attr("data-src") || $img.attr("src") || "").trim();
    const image  = (imgSrc && !imgSrc.startsWith("data:")) ? imgSrc : null;

    // ── Excerpt (lead card only) ───────────────────────────────────────────────
    const excerpt = $el.find("p.card-intro").first().text().trim();

    // ── Category from URL ─────────────────────────────────────────────────────
    const category = getTBSCategory(rawHref);

    items.push({
      title,
      link,
      description: excerpt,
      image,
      date:        new Date(),
      category,
      author:      "",
    });
  });

  console.log(`  [TBS] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: NEW AGE BD – Editorial & Opinion =====
// URL: https://www.newagebd.net/articlelist/25/editorial
//
// Two card layouts inside div.col-md-8 (main column):
//
//   Lead card  → article.card.card-full.mb-4.hover-a  (directly in col-lg-6)
//     Image    : img[data-src] inside div.image-wrapper
//     Link     : a[href] wrapping the image (= title link)
//     Title    : h2.card-title a
//     Date     : time[datetime]  →  "2026-05-21" (date-only ISO)
//     Excerpt  : p.card-text
//
//   Grid cards → article.col-xs-12  containing  div.card.card-full
//     Image    : img[data-src] inside div.image-wrapper
//     Link     : a[href] wrapping the image (= title link)
//     Title    : h3.card-title a
//     Date     : absent → new Date()
//     Excerpt  : absent
//
//   Category   : derived from URL path
//                /post/editorial/ → "Editorial"
//                /post/opinion/   → "Opinion"
//                other            → "Opinion/Editorial"

const NA_BASE = "https://www.newagebd.net";

// Placeholder images served when no real photo exists — keep them, they're valid
// but note them here for future filtering if needed:
// outspoken.newagebd.com/files/img/default.jpg
// outspoken.newagebd.com/files/img/default-md.jpg

function getNewAgeCategory(href) {
  if (href.includes("/post/editorial/")) return "Editorial";
  if (href.includes("/post/opinion/"))   return "Opinion";
  return "Opinion/Editorial";
}

function scrapeNewAge(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  // Scope to main content column only (avoid sidebar)
  const $main = $(".col-md-8");

  $main.find("article").each((_, el) => {
    const $el = $(el);

    // ── Link ──────────────────────────────────────────────────────────────────
    // Both layouts: image-wrapper anchor href == title anchor href
    const $imgAnchor = $el.find("div.image-wrapper a").first();
    const href = ($imgAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : NA_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    // ── Title (h2 for lead, h3 for grid) ─────────────────────────────────────
    const $titleAnchor = $el.find("h2.card-title a, h3.card-title a").first();
    const title = $titleAnchor.text().trim();
    if (!title) return;

    // ── Image ─────────────────────────────────────────────────────────────────
    const $img   = $el.find("div.image-wrapper img").first();
    const imgSrc = ($img.attr("data-src") || $img.attr("src") || "").trim();
    const image  = (imgSrc && !imgSrc.includes("lazy-empty")) ? imgSrc : null;

    // ── Date (lead card only; grid cards have none) ───────────────────────────
    const datetime = ($el.find("time").first().attr("datetime") || "").trim();
    const date     = datetime ? new Date(datetime) : new Date();

    // ── Excerpt (lead card only) ───────────────────────────────────────────────
    const excerpt = $el.find("p.card-text").first().text().trim();

    items.push({
      title,
      link,
      description: excerpt,
      image,
      date,
      category: getNewAgeCategory(href),
      author:   "",
    });
  });

  console.log(`  [NewAge] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: THE FINANCIAL EXPRESS – Editorial & Views =====
// URL: https://thefinancialexpress.com.bd/editorial
//      https://thefinancialexpress.com.bd/views
//
// Framework  : Nuxt.js (Vue SSR)
// Strategy   : Article data is embedded in window.__NUXT__ as a self-executing
//              function with deduplicated string arguments, e.g.:
//                window.__NUXT__ = (function(a,b,c,...){ return {...} })(null,"Editorial",...)
//              We evaluate it safely using Node's vm module (restricted context —
//              no require/process/fs access possible) to resolve all variable refs.
//
// Data path  : __NUXT__.fetch["CategorySingleParent:0"]
//   Sections : lead     (single article object)
//              posts    (array)
//              column1  (array)
//              column2  (single article object)
//              column3  (array)
//
// Per article fields (post-eval, already unicode-decoded):
//   title    → string
//   slug     → "/editorial/some-slug"  (relative path)
//   image    → absolute CDN URL
//   excerpt  → truncated text
//   datetime → "2026-05-20T16:56:55.000000Z"  (ISO 8601 UTC)

const vm = require("vm");

const FE_BASE = "https://thefinancialexpress.com.bd";

function scrapeFinancialExpress(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];
  let   nuxtData;

  // ── Evaluate window.__NUXT__ in a sandboxed vm context ────────────────────
  $("script").each((_, el) => {
    const raw = $(el).html() || "";
    if (!raw.includes("window.__NUXT__")) return;
    try {
      const ctx = vm.createContext({ window: {} });
      vm.runInContext(raw, ctx, { timeout: 5000 });
      nuxtData = ctx.window.__NUXT__;
    } catch (e) {
      console.warn(`  [FE/${catLabel}] vm eval failed: ${e.message}`);
    }
  });

  if (!nuxtData) {
    console.warn(`  [FE/${catLabel}] __NUXT__ not found or eval failed`);
    return items;
  }

  // The fetch key varies by section:
  //   Editorial  → "CategorySingleParent:0"
  //   Views      → "CategoryViews:0"
  //   others     → "Category<Name>:0"
  // Scan for any key matching Category*:0 rather than hardcoding one.
  const fetchObj = nuxtData?.fetch || {};
  const catKey   = Object.keys(fetchObj).find(k => /^Category.+:0$/.test(k));
  const catData  = catKey ? fetchObj[catKey] : null;
  if (!catData) {
    console.warn(`  [FE/${catLabel}] No Category*:0 key found in __NUXT__ (keys: ${Object.keys(fetchObj).join(", ")})`);
    return items;
  }

  // ── Collect articles from all page sections ────────────────────────────────
  const allArticles = [];

  if (catData.lead?.id)             allArticles.push(catData.lead);
  if (Array.isArray(catData.posts)) allArticles.push(...catData.posts);
  if (Array.isArray(catData.column1)) allArticles.push(...catData.column1);
  if (catData.column2?.id)          allArticles.push(catData.column2);
  if (Array.isArray(catData.column3)) allArticles.push(...catData.column3);

  for (const article of allArticles) {
    const slug = (article.slug || "").trim();
    if (!slug) continue;

    const link = slug.startsWith("http") ? slug : FE_BASE + slug;
    if (seen.has(link)) continue;
    seen.add(link);

    const title = (article.title || "").trim();
    if (!title) continue;

    items.push({
      title,
      link,
      description: (article.excerpt || "").trim(),
      image:       article.image   || null,
      date:        article.datetime ? new Date(article.datetime) : new Date(),
      category:    catLabel,
      author:      "",
    });
  }

  console.log(`  [FE/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: BANGLADESH POST – Editorial & Opinion =====
// Works for:
//   https://bangladeshpost.net/categories/editorial
//   https://bangladeshpost.net/categories/opinion
//
// Three card layouts (all share the same selector strategy):
//
//   Big lead  → a[href^="/posts/"] wraps:
//                 figure > img[data-src]  (lazyloading)
//                 h3.homepage-post-title
//                 p  (excerpt)
//
//   Mid card  → a[href^="/posts/"] wraps:
//                 img[data-src]  (lazyloading)
//                 h3.homepage-post-title
//                 p > img  (inline image first, then text)
//
//   Grid card → a[href^="/posts/"] wraps:
//                 img[data-src]  (lazyloading)
//                 h4.homepage-post-title
//
// Strategy: find all .homepage-post-title, then walk up to the nearest <a>
// to get href, image, and excerpt.  De-dupe by link.

const BDP_BASE = "https://bangladeshpost.net";

function scrapeBangladeshPost(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];

  $("h3.homepage-post-title, h4.homepage-post-title").each((_, titleEl) => {
    const $title = $(titleEl);

    // Walk up to find the enclosing <a href="/posts/...">
    const $anchor = $title.closest("a[href^=\"/posts/\"]");
    if (!$anchor.length) return;

    const href = ($anchor.attr("href") || "").trim();
    if (!href) return;

    const link = BDP_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const title = $title.text().trim();
    if (!title) return;

    // Image: first img[data-src] inside the anchor
    const $img   = $anchor.find("img[data-src]").first();
    const imgSrc = ($img.attr("data-src") || "").trim();
    const image  = (imgSrc && !imgSrc.startsWith("data:") && !imgSrc.includes("placeholder"))
      ? imgSrc : null;

    // Excerpt: first <p> inside the anchor that has visible text (not just whitespace)
    let excerpt = "";
    $anchor.find("p").each((_, p) => {
      const text = $(p).text().trim();
      if (text && !excerpt) excerpt = text;
    });

    items.push({
      title,
      link,
      description: excerpt,
      image,
      date:     new Date(),
      category: catLabel,
      author:   "",
    });
  });

  console.log(`  [BDP/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: FE TODAY – Views & Reviews / Editorial / Views & Opinion =====
// Works for:
//   https://today.thefinancialexpress.com.bd/views-reviews
//   https://today.thefinancialexpress.com.bd/editorial
//   https://today.thefinancialexpress.com.bd/views-opinion
//
// This is the print-edition site (FE Today), not the online FE.
// Each section page renders articles as a flat sequence of siblings inside
// div.col-lg-7.left-bar:
//
//   <h2>Title</h2>
//   <p>Excerpt...</p>
//   <a href='https://today.thefinancialexpress.com.bd/...' class="btn readmore btn-sm">Read more</a>
//   <div class="divider-lg"></div>
//   ... (repeats for each article)
//
// Strategy: find every a.readmore[href], then for each look back through
// prevAll() siblings for the nearest <h2> (title) and <p> (excerpt).

const FET_BASE = "https://today.thefinancialexpress.com.bd";

function scrapeFEToday(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];

  $("a.readmore[href]").each((_, el) => {
    const $a = $(el);

    const link = ($a.attr("href") || "").trim();
    if (!link || !link.startsWith("http")) return;
    if (seen.has(link)) return;
    seen.add(link);

    // prevAll returns siblings in reverse DOM order (nearest first)
    const title   = $a.prevAll("h2, h3").first().text().trim();
    const excerpt = $a.prevAll("p").first().text().trim();

    if (!title) return;

    items.push({
      title,
      link,
      description: excerpt,
      image:    null,   // No images in listing
      date:     new Date(),
      category: catLabel,
      author:   "",
    });
  });

  console.log(`  [FEToday/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: THE ASIAN AGE – Category Pages =====
// Works for:
//   https://dailyasianage.com/news-category/14/Editorial
//   https://dailyasianage.com/news-category/5/OP-ED
//
// Two card layouts inside div.abColumn:
//
//   Lead  → div.ledeStory
//             h2 a[href]                        (title + link)
//             div.ledePhoto img[src]            (image)
//             p.summary                         (excerpt)
//
//   Grid  → div.story.story-para
//             h3 a[href]                        (title + link)
//             div.thumbnail img[src]            (image)
//             p.summary a  or  p.summary        (excerpt / author)
//
// Image filter: discard URL ending in "small_" (no image assigned)
// All hrefs are absolute (https://dailyasianage.com/news/{id}/slug)

const AAC_BASE = "https://dailyasianage.com";

function scrapeAsianAgeCategory(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];

  function addItem($titleAnchor, $img, $summary) {
    const href = ($titleAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : AAC_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const title = $titleAnchor.text().trim();
    if (!title) return;

    const imgSrc = ($img.attr("src") || "").trim();
    // Discard placeholder (URL ends with "small_" and has no extension after it)
    const image  = (imgSrc && !/small_$/.test(imgSrc)) ? imgSrc : null;

    const excerpt = ($summary.text() || "").trim();

    items.push({
      title,
      link,
      description: excerpt,
      image,
      date:     new Date(),
      category: catLabel,
      author:   "",
    });
  }

  // Lead story
  $("div.ledeStory").each((_, el) => {
    const $el = $(el);
    addItem(
      $el.find("h2 a").first(),
      $el.find("div.ledePhoto img").first(),
      $el.find("p.summary").first()
    );
  });

  // Grid stories
  $("div.story.story-para").each((_, el) => {
    const $el = $(el);
    addItem(
      $el.find("h3 a").first(),
      $el.find("div.thumbnail img").first(),
      $el.find("p.summary").first()
    );
  });

  console.log(`  [AsianAge-Cat/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: THE ASIAN AGE – Today's News Page (section-scoped) =====
// Works for:
//   https://dailyasianage.com/page/todays-news  (with #cat5 / #cat14 anchors)
//
// The page contains all today's sections in a single document.  Each section
// is introduced by a named anchor and an h1.comTex with the category name:
//
//   <a name="cat5"></a>
//   <ul class="topmenu">…</ul>
//   ...
//   <div class="row"><div class="col-md-12"><h1 class="comTex">OP-ED</h1></div></div>
//   <div class="col-md-12" style="padding: 0px;">   ← article container
//     <div class="media asTop">
//       <div class="media-body">
//         <h4 class="media-heading"><a href="...">Title</a></h4>
//         <p style="float: left; width: 79%;">excerpt or author name</p>
//         <a href="..."><img src="https://dailyasianage.com/library/...jpg" …/></a>
//       </div>
//     </div>
//     …
//   </div>
//
// Strategy: locate h1.comTex whose text matches the category, navigate to
// its parent div.row, take the next sibling div.col-md-12 (the article
// container), and parse each div.media.asTop within it.

function scrapeAsianAgeToday(html, seen, catLabel, catId) {
  const $     = cheerio.load(html);
  const items = [];

  // Primary strategy: find named anchor a[name="cat{id}"], walk up 3 levels to
  // the outer section wrapper, then find all div.media.asTop within it.
  // This is more reliable than matching h1.comTex text on the live page.
  //
  // DOM path from anchor:
  //   a[name="cat{id}"]
  //     → parent  div.col-md-12  (inner nav wrapper)
  //     → parent  div.row        (first row of section)
  //     → parent  div.col-md-12  (OUTER section container)  ← search here
  let $articleContainer = null;

  const $anchor = $(`a[name="cat${catId}"]`);
  if ($anchor.length) {
    const $outer = $anchor.parent().parent().parent();
    if ($outer.length && $outer.find("div.media.asTop").length) {
      $articleContainer = $outer;
    }
  }

  // Fallback: match h1.comTex text → row → next col-md-12
  if (!$articleContainer) {
    const catH1Map = { 5: "OP-ED", 14: "Editorial" };
    const targetText = catH1Map[catId] || "";
    $("h1.comTex").each((_, h1) => {
      const text = $(h1).text().trim();
      if (!text.startsWith(targetText)) return;
      const $next = $(h1).parent().parent().next("div.col-md-12, div.row");
      if ($next.length) { $articleContainer = $next; return false; }
    });
  }

  if (!$articleContainer) {
    console.warn(`  [AsianAge-Today/${catLabel}] Section container not found`);
    return items;
  }

  $articleContainer.find("div.media.asTop").each((_, el) => {
    const $el = $(el);

    // Title + link
    const $titleAnchor = $el.find("h4.media-heading a").first();
    const href = ($titleAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : AAC_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const title = $titleAnchor.text().trim();
    if (!title) return;

    // Image: inside the last <a> that wraps an <img> in media-body
    const $imgAnchor = $el.find("div.media-body a img").first();
    const imgSrc     = ($imgAnchor.attr("src") || "").trim();
    const image      = (imgSrc && !imgSrc.startsWith("data:")) ? imgSrc : null;

    // Excerpt / author: the <p> with inline style
    const excerpt = $el.find("p[style]").first().text().trim();

    items.push({
      title,
      link,
      description: excerpt,
      image,
      date:     new Date(),
      category: catLabel,
      author:   "",
    });
  });

  console.log(`  [AsianAge-Today/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: THE NEW NATION – Editorial =====
// URL: https://dailynewnation.com/news/category/todays-news/editorial
//
// WordPress site using the Hueman Pro theme.
//
// Article cards : article.grid-item.hentry  (inside div#grid-wrapper.post-list)
//
//   Link + Title : h2.post-title.entry-title a[href]
//   Image        : div.post-thumbnail img[src]
//                  (direct src — no lazy loading)
//                  Only present when article has class has-post-thumbnail
//   Date         : time.published[datetime]  →  "2026-05-21 00:01:00"
//   Category     : p.post-category a  text
//   Excerpt      : not included in listing HTML
//   Author       : span.fn a  (but hidden with display:none on p.post-byline)

const NN_BASE = "https://dailynewnation.com";

function scrapeNewNation(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("article.grid-item").each((_, el) => {
    const $el = $(el);

    // ── Link + Title ──────────────────────────────────────────────────────────
    const $titleAnchor = $el.find("h2.post-title.entry-title a").first();
    const href = ($titleAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : NN_BASE + href;
    if (seen.has(link)) return;
    seen.add(link);

    const title = $titleAnchor.text().trim();
    if (!title) return;

    // ── Image (only if card has post thumbnail) ───────────────────────────────
    const $img   = $el.find("div.post-thumbnail img").first();
    const imgSrc = ($img.attr("src") || "").trim();
    // Filter WordPress default "no image" blobs and data URIs
    const image  = (imgSrc && !imgSrc.startsWith("data:")) ? imgSrc : null;

    // ── Date ──────────────────────────────────────────────────────────────────
    const datetime = ($el.find("time.published").first().attr("datetime") || "").trim();
    const date     = datetime ? new Date(datetime) : new Date();

    // ── Category ──────────────────────────────────────────────────────────────
    const category = $el.find("p.post-category a").first().text().trim() || "Editorial";

    items.push({
      title,
      link,
      description: "",
      image,
      date,
      category,
      author: "",
    });
  });

  console.log(`  [NewNation] Scraped ${items.length} articles`);
  return items;
}

// ===== SOURCE REGISTRY =====
const SOURCES = [
  // ── Times of Bangladesh ───────────────────────────────────────────────────
  {
    label:   "Times of Bangladesh – Opinion",
    url:     "https://tob.news/category/opinion/",
    scraper: (html, seen) => scrapeTOB(html, seen, "Opinion"),
  },
  {
    label:   "Times of Bangladesh – Navid",
    url:     "https://tob.news/author/navid/",
    scraper: (html, seen) => scrapeTOB(html, seen, "Opinion"),
  },
  {
    label:   "Times of Bangladesh – Times Opinion",
    url:     "https://tob.news/author/timesopinion/",
    scraper: (html, seen) => scrapeTOB(html, seen, "Opinion"),
  },
  // ── The Business Standard ─────────────────────────────────────────────────
  {
    label:   "The Business Standard – Features",
    url:     "https://www.tbsnews.net/features",
    scraper: scrapeTBS,
  },
  {
    label:   "The Business Standard – Thoughts",
    url:     "https://www.tbsnews.net/thoughts",
    scraper: scrapeTBS,
  },
  // ── New Age BD ────────────────────────────────────────────────────────────
  {
    label:   "New Age BD – Editorial & Opinion",
    url:     "https://www.newagebd.net/articlelist/25/editorial",
    scraper: scrapeNewAge,
  },
  // ── The Financial Express ─────────────────────────────────────────────────
  {
    label:   "The Financial Express – Editorial",
    url:     "https://thefinancialexpress.com.bd/editorial",
    scraper: (html, seen) => scrapeFinancialExpress(html, seen, "Editorial"),
  },
  {
    label:   "The Financial Express – Views",
    url:     "https://thefinancialexpress.com.bd/views",
    scraper: (html, seen) => scrapeFinancialExpress(html, seen, "Views"),
  },
  // ── FE Today (print edition) ──────────────────────────────────────────────
  {
    label:   "FE Today – Views & Reviews",
    url:     "https://today.thefinancialexpress.com.bd/views-reviews",
    scraper: (html, seen) => scrapeFEToday(html, seen, "Views & Reviews"),
  },
  {
    label:   "FE Today – Editorial",
    url:     "https://today.thefinancialexpress.com.bd/editorial",
    scraper: (html, seen) => scrapeFEToday(html, seen, "Editorial"),
  },
  {
    label:   "FE Today – Views & Opinion",
    url:     "https://today.thefinancialexpress.com.bd/views-opinion",
    scraper: (html, seen) => scrapeFEToday(html, seen, "Views & Opinion"),
  },
  // ── The Asian Age – Category pages ────────────────────────────────────────
  {
    label:   "The Asian Age – Editorial",
    url:     "https://dailyasianage.com/news-category/14/Editorial",
    scraper: (html, seen) => scrapeAsianAgeCategory(html, seen, "Editorial"),
  },
  {
    label:   "The Asian Age – OP-ED",
    url:     "https://dailyasianage.com/news-category/5/OP-ED",
    scraper: (html, seen) => scrapeAsianAgeCategory(html, seen, "OP-ED"),
  },
  // ── The Asian Age – Today's News (section-scoped) ─────────────────────────
  // Note: both URLs resolve to the same base page; fragment (#cat*) is for
  // browser navigation only. Both entries fetch the same HTML but scope to
  // their respective category section via scrapeAsianAgeToday().
  {
    label:   "The Asian Age Today – OP-ED",
    url:     "https://dailyasianage.com/page/todays-news",
    scraper: (html, seen) => scrapeAsianAgeToday(html, seen, "OP-ED", 5),
  },
  {
    label:   "The Asian Age Today – Editorial",
    url:     "https://dailyasianage.com/page/todays-news",
    scraper: (html, seen) => scrapeAsianAgeToday(html, seen, "Editorial", 14),
  },
  // ── Bangladesh Post ───────────────────────────────────────────────────────
  {
    label:   "Bangladesh Post – Editorial",
    url:     "https://bangladeshpost.net/categories/editorial",
    scraper: (html, seen) => scrapeBangladeshPost(html, seen, "Editorial"),
  },
  {
    label:   "Bangladesh Post – Opinion",
    url:     "https://bangladeshpost.net/categories/opinion",
    scraper: (html, seen) => scrapeBangladeshPost(html, seen, "Opinion"),
  },
  // ── The New Nation ────────────────────────────────────────────────────────
  {
    label:   "The New Nation – Editorial",
    url:     "https://dailynewnation.com/news/category/todays-news/editorial",
    scraper: scrapeNewNation,
  },
];

// ===== LOAD EXISTING ITEMS FROM XML =====
function loadExistingItems(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const xml    = fs.readFileSync(filePath, "utf8");
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const items  = [];

  for (const block of blocks) {
    const get = (tag) => {
      const m = block.match(
        new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([^<]*)<\\/${tag}>`)
      );
      return m ? (m[1] !== undefined ? m[1] : m[2]) : "";
    };
    const getAttr = (tag, attr) => {
      const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`));
      return m ? m[1] : null;
    };

    const link = get("link").trim();
    if (!link) continue;

    items.push({
      title:       get("title"),
      link,
      description: get("description"),
      category:    get("category"),
      image:       getAttr("media:content", "url") || getAttr("media:thumbnail", "url") || null,
      date:        new Date(get("pubDate") || Date.now()),
    });
  }

  console.log(`  Loaded ${items.length} existing items from ${filePath}`);
  return items;
}

// ===== BUILD XML =====
function buildFeed(items) {
  const feed = new RSS({
    title:       "Bangladesh English Press – Opinion, Features & Thoughts",
    description: "Opinion and features from Times of Bangladesh and The Business Standard",
    feed_url:    "https://tob.news/category/opinion/",
    site_url:    "https://tob.news",
    language:    "en",
    pubDate:     new Date().toUTCString(),
    custom_namespaces: { media: "http://search.yahoo.com/mrss/" },
  });

  for (const item of items) {
    const customElements = [];
    if (item.image) {
      customElements.push({ "media:content":   { _attr: { url: item.image, medium: "image" } } });
      customElements.push({ "media:thumbnail": { _attr: { url: item.image } } });
    }
    feed.item({
      title:           item.title,
      url:             item.link,
      description:     item.description || undefined,
      categories:      item.category ? [item.category] : undefined,
      date:            item.date,
      author:          item.author || undefined,
      custom_elements: customElements.length ? customElements : undefined,
    });
  }

  return feed.xml({ indent: true });
}

// ===== MAIN =====
async function generateRSS() {
  try {
    const seen       = new Set();
    let   newItems   = [];
    const fetchCache = new Map(); // avoid duplicate FlareSolverr calls for same URL

    for (const source of SOURCES) {
      console.log(`\n--- ${source.label} ---`);
      try {
        // Strip fragment (#cat5, #cat14, etc.) for the actual HTTP request
        const fetchUrl = source.url.split("#")[0];
        let html;
        if (fetchCache.has(fetchUrl)) {
          console.log(`  (using cached HTML for ${fetchUrl})`);
          html = fetchCache.get(fetchUrl);
        } else {
          html = await fetchWithFlareSolverr(fetchUrl);
          fetchCache.set(fetchUrl, html);
        }
        const items = source.scraper(html, seen);
        newItems = newItems.concat(items);
      } catch (err) {
        console.error(`❌ Failed to scrape ${source.url}: ${err.message}`);
      }
    }

    console.log(`\nNew articles scraped: ${newItems.length}`);

    const existingItems = loadExistingItems(OUTPUT_FILE);
    existingItems.forEach(item => seen.add(item.link));

    const trulyNew = newItems.filter(
      item => !existingItems.some(e => e.link === item.link)
    );
    console.log(`Truly new (not in existing feed): ${trulyNew.length}`);

    const merged = [...trulyNew, ...existingItems].slice(0, MAX_ITEMS);
    console.log(`Merged feed size: ${merged.length} / ${MAX_ITEMS}`);

    if (merged.length === 0) {
      merged.push({
        title:       "No articles found yet",
        link:        "https://tob.news",
        description: "RSS feed could not scrape any articles.",
        category:    "",
        image:       null,
        date:        new Date(),
      });
    }

    fs.writeFileSync(OUTPUT_FILE, buildFeed(merged));
    console.log(`\n✅ RSS written with ${merged.length} items → ${OUTPUT_FILE}`);

  } catch (err) {
    console.error("❌ Fatal error:", err.message);

    if (!fs.existsSync(OUTPUT_FILE)) {
      const feed = new RSS({
        title:       "Feed (error fallback)",
        description: "RSS feed failed to scrape.",
        feed_url:    "https://tob.news",
        site_url:    "https://tob.news",
        language:    "en",
        pubDate:     new Date().toUTCString(),
      });
      feed.item({
        title:       "Feed generation failed",
        url:         "https://tob.news",
        description: "An error occurred during scraping.",
        date:        new Date(),
      });
      fs.writeFileSync(OUTPUT_FILE, feed.xml({ indent: true }));
    } else {
      console.log("⚠️  Keeping existing feed intact.");
    }
  }
}

generateRSS();
