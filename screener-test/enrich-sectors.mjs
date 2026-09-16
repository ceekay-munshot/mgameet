// enrich-sectors.mjs — resolve sector / industry / sub-industry / ticker per company.
//
// Cache: public/data/company-meta.json
//   { [company_url]: { company, ticker, sector, industry, sub_industry, _tries } }
//   Only companies that (a) have events and (b) aren't resolved yet are fetched.
//   Self-healing: a resolved value is never overwritten with null.
//
// Env: ENRICH_LIMIT (default 40) caps companies per run. HEADFUL=1 to watch.
//   Screener selectors are BEST-EFFORT — run with DEBUG=1 to dump a page and tune.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, UA, sleep, login, readJson, writeJson } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(HERE, "output");
const DATA = path.join(ROOT, "public", "data");

const MAX_TRIES = 3; // stop re-visiting a company whose page never exposes a classification

function isResolved(m) {
  if (!m) return false;
  if (m.sector || m.industry) return true;      // got the classification
  if ((m._tries || 0) >= MAX_TRIES) return true; // give up gracefully
  return false;
}

// Best-effort scrape of the Screener company page.
async function parseCompanyMeta(page) {
  return await page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const txt = clean(document.body.innerText || "");
    const company = clean(document.querySelector("h1")?.innerText || "");

    // Ticker — Screener prints "NSE : XXXX" and "BSE : 500123".
    const nse = txt.match(/NSE\s*[:\-]?\s*([A-Z][A-Z0-9&.\-]{1,19})/);
    const bse = txt.match(/BSE\s*[:\-]?\s*(\d{4,7})/);
    const ticker = (nse && nse[1]) || (bse && bse[1]) || null;

    let sector = null, industry = null, sub_industry = null;

    // Strategy A: explicit labels in the page text.
    const lab = (name) => {
      const m = txt.match(new RegExp(name + "\\s*[:\\-]\\s*([A-Za-z&,'()\\-/ ]{2,60})"));
      return m ? m[1].trim().replace(/\s+(About|Website|BSE|NSE|Compare|Peers).*$/i, "").trim() : null;
    };
    sector = lab("Sector");
    industry = lab("Industry");
    sub_industry = lab("Sub[- ]?Industry") || lab("Sub[- ]?Sector");

    // Strategy B: peer-comparison / breadcrumb links each point at a classification group.
    if (!industry || !sector) {
      const links = Array.from(document.querySelectorAll('a[href*="/company/compare/"], nav.breadcrumb a, .breadcrumb a, [class*="breadcrumb"] a'))
        .map((a) => clean(a.textContent))
        .filter((t) => t && t.length > 1 && !/compare|companies|peers|home|screens?/i.test(t));
      const uniq = [...new Set(links)];
      if (!sector && uniq[0]) sector = uniq[0];
      if (!industry && uniq[1]) industry = uniq[1];
      if (!sub_industry && uniq[2]) sub_industry = uniq[2];
    }

    const norm = (s) => { s = clean(s); return s && s.length <= 60 ? s : null; };
    return { company: company || null, ticker, sector: norm(sector), industry: norm(industry), sub_industry: norm(sub_industry) };
  });
}

export async function main() {
  const ENRICH_LIMIT = parseInt(process.env.ENRICH_LIMIT || "40", 10) || 40;
  const store = await readJson(path.join(DATA, "_raw-events.json"), {});
  const meta = await readJson(path.join(DATA, "company-meta.json"), {});

  // Only enrich companies that actually have events (those become published rows).
  const targets = new Map(); // company_url -> company name
  for (const v of Object.values(store)) {
    if (v && v.company_url && Array.isArray(v.events) && v.events.length) targets.set(v.company_url, v.company);
  }
  const todo = [...targets.keys()].filter((u) => !isResolved(meta[u]));
  console.log(`enrich-sectors: ${targets.size} companies with events, ${todo.length} to resolve (limit ${ENRICH_LIMIT})`);

  if (!todo.length) {
    await writeJson(path.join(DATA, "company-meta.json"), meta);
    console.log("enrich-sectors: nothing new to resolve.");
    return meta;
  }

  const browser = await chromium.launch({ headless: !process.env.HEADFUL });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  let resolved = 0;

  try {
    if (process.env.SCREENER_EMAIL && process.env.SCREENER_PASSWORD) {
      try { await login(page); } catch (e) { console.log(`  (login skipped: ${String(e?.message || e).slice(0, 80)})`); }
    }
    for (const url of todo) {
      if (resolved >= ENRICH_LIMIT) break;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForSelector("h1", { timeout: 10000 }).catch(() => {});
        if (process.env.DEBUG) {
          await fs.mkdir(OUT, { recursive: true });
          await fs.writeFile(path.join(OUT, `debug-company-${resolved}.html`), await page.content());
        }
        const m = await parseCompanyMeta(page);
        const prev = meta[url] || {};
        meta[url] = {
          company: targets.get(url) || m.company || prev.company || null,
          // self-healing: keep any previously-resolved value rather than overwrite with null
          ticker: m.ticker || prev.ticker || null,
          sector: m.sector || prev.sector || null,
          industry: m.industry || prev.industry || null,
          sub_industry: m.sub_industry || prev.sub_industry || null,
          _tries: (prev._tries || 0) + 1,
        };
        resolved++;
        console.log(`  · ${meta[url].company || url}  [${meta[url].sector || "?"} / ${meta[url].industry || "?"}]  ${meta[url].ticker || ""}`);
      } catch (e) {
        const prev = meta[url] || {};
        meta[url] = { ...prev, company: targets.get(url) || prev.company || null, _tries: (prev._tries || 0) + 1 };
        console.log(`  ! ${url}: ${String(e?.message || e).slice(0, 100)}`);
      }
      await sleep(1200); // gentle rate-limit
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  await writeJson(path.join(DATA, "company-meta.json"), meta);
  console.log(`enrich-sectors: resolved ${resolved} this run (cache holds ${Object.keys(meta).length})`);
  return meta;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
