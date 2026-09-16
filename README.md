# Meets Tracker — data engine

Live "Investor Meet Tracker" for Indian listed companies.

Indian listed companies must disclose (SEBI LODR Reg 30) every upcoming
analyst/investor meeting, plant visit, or conference to BSE/NSE. Each disclosure
is a short PDF with a schedule table. This project:

1. **Scrapes** Screener.in's announcements feed for investor-engagement filings.
2. **Reads** each source PDF with **Claude (via Amazon Bedrock)**.
3. **Publishes** a clean, forward-looking `public/data/events.json` — *who is
   meeting whom, and when* — every row source-backed with the exchange PDF link.

> This repo is **Prompt 1 of 3 — the data engine only**. `public/index.html` is a
> tiny placeholder that just verifies the deploy + data. The real dashboard UI is
> Prompt 2.

## Golden rules baked in

- **Meeting date is king.** Each PDF has a filing date *and* a meeting date — we
  extract, sort, and filter on the **meeting** date.
- **Source-backed.** Every event row carries the exchange PDF link (`pdf_url`).
- **Forward-looking.** Scan announcements filed in the last **15 days**; keep only
  events whose meeting date is `>= today` and within a **60-day** horizon.
- **Incremental & cheap.** A PDF is never sent to Claude twice — already-processed
  announcements are skipped.

## Pipeline

```
scrape-announcements  ->  extract-events  ->  enrich-sectors  ->  build-events
   (Screener feed)       (PDF -> Claude)      (sector/ticker)     (events.json)
```

| Script | What it does | Reads | Writes |
| --- | --- | --- | --- |
| `screener-test/scrape-announcements.mjs` | Collect investor-engagement rows from the feed (last 15 days) | Screener | `screener-test/output/announcements-index.json` |
| `screener-test/extract-events.mjs` | PDF → structured events via Claude (incremental) | index | `public/data/_raw-events.json` |
| `screener-test/enrich-sectors.mjs` | Best-effort sector / industry / sub-industry / ticker | raw store | `public/data/company-meta.json` |
| `screener-test/build-events.mjs` | Filter to horizon, dedupe, sort, publish | raw + meta | `public/data/events.json`, `public/data/metadata.json` |
| `screener-test/run-pipeline.mjs` | Runs all four (each isolated in try/catch) | — | — |
| `screener-test/helpers.mjs` | Shared login / PDF-fetch / date / JSON helpers | — | — |
| `screener-test/llm.mjs` | Claude on Bedrock (Converse API + bearer key) | — | — |

## `events.json` schema

```jsonc
{
  "generated_at": "2026-09-16T01:35:00.000Z",
  "backfill_days": 15,
  "horizon_days": 60,
  "count": 42,
  "events": [
    {
      "id": "acme-industries-2026-09-20-conference-anand-rathi-g-200-summit",
      "company": "Acme Industries",
      "company_url": "https://www.screener.in/company/ACME/",
      "ticker": "ACME",
      "sector": "Chemicals",
      "industry": "Specialty Chemicals",
      "sub_industry": null,
      "event_type": "Conference",          // One-on-One | Group Meeting | Analyst Meet | Investor Meet | Conference | Plant Visit | Investor Day | Earnings Call | Other
      "event_date": "2026-09-20",          // THE MEETING DATE (never the filing date)
      "event_time": "10:30",               // or null
      "mode": "In-person",                 // Virtual | In-person | Hybrid | null
      "counterparty": "Anand Rathi G-200 Summit",
      "venue": "Mumbai",                   // or null
      "heading": "Schedule of analyst / investor meet",
      "announced_at": "2026-09-15",        // filing date (IST)
      "pdf_url": "https://www.bseindia.com/.../file.pdf",
      "first_seen": "2026-09-16T01:35:00.000Z"
    }
  ]
}
```

`metadata.json`:

```jsonc
{
  "updated_at": "2026-09-16T01:35:00.000Z",
  "total_upcoming": 42,
  "today_count": 3,
  "week_count": 11,          // next 7 days
  "companies": 30,           // distinct companies
  "types": { "Conference": 12, "Analyst Meet": 9, "One-on-One": 21 }
}
```

## Environment / secrets

| Var | Required | Purpose |
| --- | --- | --- |
| `SCREENER_EMAIL` | yes | Screener.in login |
| `SCREENER_PASSWORD` | yes | Screener.in login |
| `SCREENER_FILTER_URL` | optional | A saved-filter announcements feed (e.g. `https://www.screener.in/announcements/user-filters/<ID>/`). Falls back to the general feed. |
| `BEDROCK_API_KEY` | yes | Amazon Bedrock bearer API key (Claude) |
| `BEDROCK_REGION` | optional | Default `us-east-1` |
| `BEDROCK_MODEL_ID` | optional | Default `us.anthropic.claude-3-5-sonnet-20241022-v2:0` |
| `SCRAPE_DO_API_KEY` | optional | scrape.do fallback for stubborn PDF fetches |

**Bedrock note:** `BEDROCK_MODEL_ID` must be a Claude model **enabled in your
Bedrock account/region** (format like `us.anthropic.claude-...-v1:0`). The default
is Claude 3.5 Sonnet v2, which supports document (PDF) input. Enable it under
**AWS Bedrock console → Model access**. If the call errors, that is the fix.

Tuning env: `LIMIT` (cap new PDFs/run, 0 = all), `FORCE=1` (reprocess all),
`ENRICH_LIMIT` (default 40), `HORIZON_DAYS` (default 60), `HEADFUL=1`, `DEBUG=1`.

## Run it

Dependencies are installed **no-save** (nothing committed to `node_modules/`):

```bash
npm install playwright@1 cheerio@1 pdfjs-dist --no-save
npx playwright install --with-deps chromium

# full run
node screener-test/run-pipeline.mjs

# quick smoke test — only 3 new PDFs
LIMIT=3 node screener-test/run-pipeline.mjs
```

Individual stages can be run standalone, e.g. `node screener-test/build-events.mjs`.

## Deploy

Static site served by a Cloudflare Worker from `./public` via the `ASSETS`
binding (`wrangler.jsonc`, `worker/index.js`). A daily GitHub Action
(`.github/workflows/daily-refresh.yml`, 07:05 IST) runs the pipeline and commits
`public/data` on `main`. Set the secrets above in the repo's Actions secrets.
