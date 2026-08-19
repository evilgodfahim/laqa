const fs      = require("fs");
const axios   = require("axios");
const cheerio = require("cheerio");
const RSS     = require("rss");
const vm      = require("vm");

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
const TOB_BASE = "https://tob.news";

function scrapeTOB(html, seen, category) {
  const $     = cheerio.load(html);
  const items = [];

  $(".is-title.post-title a").each((_, anchorEl) => {
    const $a   = $(anchorEl);
    const href = ($a.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : TOB_BASE + href;
    if (seen.has(link)) return;

    const title = $a.text().trim();
    if (!title) return;

    // Scope to enclosing <article> or fallback to .post-meta wrapper
    const $card = $a.closest("article").length ? $a.closest("article") : $a.closest(".post-meta");

    // ── Image (data-src or fallback to src) ───────────────────────────────────
    const $img  = $card.find("div.media img, img.wp-post-image").first();
    const image = ($img.attr("data-src") || $img.attr("src") || "").trim();
    const finalImage = (image && !image.startsWith("data:")) ? image : null;

    // ── Date ──────────────────────────────────────────────────────────────────
    const datetime = ($card.find("time.post-date").first().attr("datetime") || "").trim();
    const date     = datetime ? new Date(datetime) : new Date();

    // ── Author ────────────────────────────────────────────────────────────────
    const author = $card.find("span.meta-item.post-author a").first().text().trim() || "";

    // ── Excerpt ───────────────────────────────────────────────────────────────
    const excerpt = $card.find("div.excerpt p").first().text().trim();

    seen.add(link);
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

// ===== SCRAPER: THE BUSINESS STANDARD =====
const TBS_BASE = "https://www.tbsnews.net";

const TBS_SUBCAT_MAP = {
  "panorama":            "Panorama",
  "big-picture":         "The Big Picture",
  "pursuit":             "Pursuit",
  "habitat":             "Habitat",
  "tales-from-the-edge": "Tales from the Edge",
  "mode":                "Mode",
  "explorer":            "Explorer",
  "brands":              "Brands",
  "focus":               "In Focus",
  "book-review":         "Book Review",
  "food":                "Food",
  "luxury":              "Luxury",
  "wheels":              "Wheels",
  "humour":              "Humour",
  "game-reviews":        "Game Reviews",
  "wealth":              "Wealth",
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
  const $view = $("div.view-content");

  $view.find("div.card").each((_, el) => {
    const $el = $(el);

    const $imgAnchor = $el.find("div.card-image a").first();
    const rawHref    = ($imgAnchor.attr("href") || "").trim();
    if (!rawHref) return;

    if (!rawHref.startsWith("/features") && !rawHref.startsWith("/thoughts")) return;

    const link = rawHref.startsWith("http") ? rawHref : TBS_BASE + rawHref;
    if (seen.has(link)) return;

    const $titleAnchor = $el.find("h2.card-title a, h3.card-title a").first();
    const title        = $titleAnchor.text().trim();
    if (!title) return;

    seen.add(link);

    const $img   = $el.find("div.card-image img").first();
    const imgSrc = ($img.attr("data-src") || $img.attr("src") || "").trim();
    const image  = (imgSrc && !imgSrc.startsWith("data:")) ? imgSrc : null;

    const excerpt  = $el.find("p.card-intro").first().text().trim();
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

// ===== SCRAPER: NEW AGE BD =====
const NA_BASE = "https://www.newagebd.net";

function getNewAgeCategory(href) {
  if (href.includes("/post/editorial/")) return "Editorial";
  if (href.includes("/post/opinion/"))   return "Opinion";
  return "Opinion/Editorial";
}

function scrapeNewAge(html, seen) {
  const $     = cheerio.load(html);
  const items = [];
  const $main = $(".col-md-8");

  $main.find("article").each((_, el) => {
    const $el = $(el);

    const $imgAnchor = $el.find("div.image-wrapper a").first();
    const href = ($imgAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : NA_BASE + href;
    if (seen.has(link)) return;

    const $titleAnchor = $el.find("h2.card-title a, h3.card-title a").first();
    const title = $titleAnchor.text().trim();
    if (!title) return;

    seen.add(link);

    const $img   = $el.find("div.image-wrapper img").first();
    const imgSrc = ($img.attr("data-src") || $img.attr("src") || "").trim();
    const image  = (imgSrc && !imgSrc.includes("lazy-empty")) ? imgSrc : null;

    const datetime = ($el.find("time").first().attr("datetime") || "").trim();
    const date     = datetime ? new Date(datetime) : new Date();
    const excerpt  = $el.find("p.card-text").first().text().trim();

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

// ===== SCRAPER: THE FINANCIAL EXPRESS =====
const FE_BASE = "https://thefinancialexpress.com.bd";

function scrapeFinancialExpress(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];
  let   nuxtData;

  // ── 1. Try extracting via window.__NUXT__ ─────────────────────────────────
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

  if (nuxtData) {
    const fetchObj = nuxtData?.fetch || {};
    const catKey   = Object.keys(fetchObj).find(k => /^Category.+:0$/.test(k));
    const catData  = catKey ? fetchObj[catKey] : null;

    if (catData) {
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
          image:       article.image || null,
          date:        article.datetime ? new Date(article.datetime) : new Date(),
          category:    catLabel,
          author:      "",
        });
      }
    }
  }

  // ── 2. Fallback: Parse HTML DOM directly if __NUXT__ failed or was empty ──
  if (items.length === 0) {
    $("article").each((_, el) => {
      const $el = $(el);

      const $titleAnchor = $el.find("h2 a, h3 a").first();
      const href = ($titleAnchor.attr("href") || "").trim();
      if (!href) return;

      const link = href.startsWith("http") ? href : FE_BASE + href;
      if (seen.has(link)) return;

      const title = $titleAnchor.text().trim();
      if (!title) return;

      seen.add(link);

      const excerpt = $el.find("p").first().text().trim();

      let image = null;
      const $img = $el.find("img").first();
      const imgSrc = ($img.attr("src") || $img.attr("data-src") || "").trim();

      if (imgSrc) {
        if (imgSrc.includes("url=")) {
          try {
            const parsedUrl = new URL(imgSrc, FE_BASE);
            const rawCdnUrl = parsedUrl.searchParams.get("url");
            if (rawCdnUrl) image = decodeURIComponent(rawCdnUrl);
          } catch (_) {}
        }
        if (!image) {
          image = imgSrc.startsWith("http") ? imgSrc : FE_BASE + imgSrc;
        }
      }

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
  }

  console.log(`  [FE/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: BANGLADESH POST =====
const BDP_BASE = "https://bangladeshpost.net";

function scrapeBangladeshPost(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];

  $("h3.homepage-post-title, h4.homepage-post-title").each((_, titleEl) => {
    const $title  = $(titleEl);
    const $anchor = $title.closest("a[href^=\"/posts/\"]");
    if (!$anchor.length) return;

    const href = ($anchor.attr("href") || "").trim();
    if (!href) return;

    const link = BDP_BASE + href;
    if (seen.has(link)) return;

    const title = $title.text().trim();
    if (!title) return;

    seen.add(link);

    const $img   = $anchor.find("img[data-src]").first();
    const imgSrc = ($img.attr("data-src") || "").trim();
    const image  = (imgSrc && !imgSrc.startsWith("data:") && !imgSrc.includes("placeholder"))
      ? imgSrc : null;

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

// ===== SCRAPER: FE TODAY (print edition) =====
function scrapeFEToday(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];

  $("a.readmore[href]").each((_, el) => {
    const $a   = $(el);
    const link = ($a.attr("href") || "").trim();
    if (!link || !link.startsWith("http")) return;
    if (seen.has(link)) return;

    const title   = $a.prevAll("h2, h3").first().text().trim();
    const excerpt = $a.prevAll("p").first().text().trim();
    if (!title) return;

    seen.add(link);

    items.push({
      title,
      link,
      description: excerpt,
      image:    null,
      date:     new Date(),
      category: catLabel,
      author:   "",
    });
  });

  console.log(`  [FEToday/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: THE ASIAN AGE =====
const AAC_BASE = "https://dailyasianage.com";

function scrapeAsianAgeCategory(html, seen, catLabel) {
  const $     = cheerio.load(html);
  const items = [];

  function addItem($titleAnchor, $img, $summary) {
    const href = ($titleAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : AAC_BASE + href;
    if (seen.has(link)) return;

    const title = $titleAnchor.text().trim();
    if (!title) return;

    seen.add(link);

    const imgSrc = ($img.attr("src") || "").trim();
    const image  = (imgSrc && !/small_$/.test(imgSrc)) ? imgSrc : null;

    items.push({
      title,
      link,
      description: ($summary.text() || "").trim(),
      image,
      date:     new Date(),
      category: catLabel,
      author:   "",
    });
  }

  $("div.ledeStory").each((_, el) => {
    const $el = $(el);
    addItem($el.find("h2 a").first(), $el.find("div.ledePhoto img").first(), $el.find("p.summary").first());
  });

  $("div.story.story-para").each((_, el) => {
    const $el = $(el);
    addItem($el.find("h3 a").first(), $el.find("div.thumbnail img").first(), $el.find("p.summary").first());
  });

  console.log(`  [AsianAge-Cat/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

function scrapeAsianAgeToday(html, seen, catLabel, catId) {
  const $     = cheerio.load(html);
  const items = [];
  let $articleContainer = null;

  const $anchor = $(`a[name="cat${catId}"]`);
  if ($anchor.length) {
    const $outer = $anchor.parent().parent().parent();
    if ($outer.length && $outer.find("div.media.asTop").length) {
      $articleContainer = $outer;
    }
  }

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

    const $titleAnchor = $el.find("h4.media-heading a").first();
    const href = ($titleAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : AAC_BASE + href;
    if (seen.has(link)) return;

    const title = $titleAnchor.text().trim();
    if (!title) return;

    seen.add(link);

    const $imgAnchor = $el.find("div.media-body a img").first();
    const imgSrc     = ($imgAnchor.attr("src") || "").trim();
    const image      = (imgSrc && !imgSrc.startsWith("data:")) ? imgSrc : null;

    items.push({
      title,
      link,
      description: $el.find("p[style]").first().text().trim(),
      image,
      date:     new Date(),
      category: catLabel,
      author:   "",
    });
  });

  console.log(`  [AsianAge-Today/${catLabel}] Scraped ${items.length} articles`);
  return items;
}

// ===== SCRAPER: THE NEW NATION =====
const NN_BASE = "https://dailynewnation.com";

function scrapeNewNation(html, seen) {
  const $     = cheerio.load(html);
  const items = [];

  $("article.grid-item").each((_, el) => {
    const $el = $(el);

    const $titleAnchor = $el.find("h2.post-title.entry-title a").first();
    const href = ($titleAnchor.attr("href") || "").trim();
    if (!href) return;

    const link = href.startsWith("http") ? href : NN_BASE + href;
    if (seen.has(link)) return;

    const title = $titleAnchor.text().trim();
    if (!title) return;

    seen.add(link);

    const $img   = $el.find("div.post-thumbnail img").first();
    const imgSrc = ($img.attr("src") || "").trim();
    const image  = (imgSrc && !imgSrc.startsWith("data:")) ? imgSrc : null;

    const datetime = ($el.find("time.published").first().attr("datetime") || "").trim();
    const date     = datetime ? new Date(datetime) : new Date();
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
  { label: "Times of Bangladesh – Opinion", url: "https://tob.news/category/opinion/", scraper: (html, seen) => scrapeTOB(html, seen, "Opinion") },
  { label: "Times of Bangladesh – Navid", url: "https://tob.news/author/navid/", scraper: (html, seen) => scrapeTOB(html, seen, "Opinion") },
  { label: "Times of Bangladesh – Times Opinion", url: "https://tob.news/author/timesopinion/", scraper: (html, seen) => scrapeTOB(html, seen, "Opinion") },
  { label: "The Business Standard – Features", url: "https://www.tbsnews.net/features", scraper: scrapeTBS },
  { label: "The Business Standard – Thoughts", url: "https://www.tbsnews.net/thoughts", scraper: scrapeTBS },
  { label: "New Age BD – Editorial & Opinion", url: "https://www.newagebd.net/articlelist/25/editorial", scraper: scrapeNewAge },
  { label: "The Financial Express – Editorial", url: "https://thefinancialexpress.com.bd/editorial", scraper: (html, seen) => scrapeFinancialExpress(html, seen, "Editorial") },
  { label: "The Financial Express – Views", url: "https://thefinancialexpress.com.bd/views", scraper: (html, seen) => scrapeFinancialExpress(html, seen, "Views") },
  { label: "FE Today – Views & Reviews", url: "https://today.thefinancialexpress.com.bd/views-reviews", scraper: (html, seen) => scrapeFEToday(html, seen, "Views & Reviews") },
  { label: "FE Today – Editorial", url: "https://today.thefinancialexpress.com.bd/editorial", scraper: (html, seen) => scrapeFEToday(html, seen, "Editorial") },
  { label: "FE Today – Views & Opinion", url: "https://today.thefinancialexpress.com.bd/views-opinion", scraper: (html, seen) => scrapeFEToday(html, seen, "Views & Opinion") },
  { label: "The Asian Age – Editorial", url: "https://dailyasianage.com/news-category/14/Editorial", scraper: (html, seen) => scrapeAsianAgeCategory(html, seen, "Editorial") },
  { label: "The Asian Age – OP-ED", url: "https://dailyasianage.com/news-category/5/OP-ED", scraper: (html, seen) => scrapeAsianAgeCategory(html, seen, "OP-ED") },
  { label: "The Asian Age Today – OP-ED", url: "https://dailyasianage.com/page/todays-news", scraper: (html, seen) => scrapeAsianAgeToday(html, seen, "OP-ED", 5) },
  { label: "The Asian Age Today – Editorial", url: "https://dailyasianage.com/page/todays-news", scraper: (html, seen) => scrapeAsianAgeToday(html, seen, "Editorial", 14) },
  { label: "Bangladesh Post – Editorial", url: "https://bangladeshpost.net/categories/editorial", scraper: (html, seen) => scrapeBangladeshPost(html, seen, "Editorial") },
  { label: "Bangladesh Post – Opinion", url: "https://bangladeshpost.net/categories/opinion", scraper: (html, seen) => scrapeBangladeshPost(html, seen, "Opinion") },
  { label: "The New Nation – Editorial", url: "https://dailynewnation.com/news/category/todays-news/editorial", scraper: scrapeNewNation },
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
    const fetchCache = new Map();

    for (const source of SOURCES) {
      console.log(`\n--- ${source.label} ---`);
      try {
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
      console.log("⚠️ Keeping existing feed intact.");
    }
  }
}

generateRSS();
