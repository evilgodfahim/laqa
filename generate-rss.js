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
    const seen     = new Set();
    let   newItems = [];

    for (const source of SOURCES) {
      console.log(`\n--- ${source.label} ---`);
      try {
        const html  = await fetchWithFlareSolverr(source.url);
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
