// ═══════════════════════════════════════════════════════════════════════════
// SOLYCO WEALTH — TACTICAL TILT MONITOR — DATA FETCHER
//
// Runs on a schedule via GitHub Actions. Pulls all six series from FRED,
// computes every derived value (52-week high, consecutive-day streaks,
// 60-day widening), and writes data.json for the front-end to read.
//
// The API key is read from the FRED_API_KEY environment variable, which is
// supplied by GitHub Actions from repository secrets. It is never written
// into data.json and never reaches the browser.
//
// Requires Node 18+ (uses built-in fetch). No npm dependencies.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');

const FRED_KEY = process.env.FRED_API_KEY;
if (!FRED_KEY) {
  console.error('FATAL: FRED_API_KEY environment variable is not set.');
  process.exit(1);
}

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const errors = [];

// ── Date helpers ─────────────────────────────────────────────────────────
const iso = (d) => d.toISOString().split('T')[0];
const today = () => iso(new Date());

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
}

// Whole calendar days between two YYYY-MM-DD strings
function calendarDaysBetween(a, b) {
  const ms = new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

// N days before a specific anchor date (NOT before "today").
// Lookbacks must be measured from the latest OBSERVATION, otherwise the window
// drifts on weekends, holidays, and whenever FRED publishes with a lag.
function daysBefore(anchorDate, n) {
  const d = new Date(anchorDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}

// ── FRED fetch ───────────────────────────────────────────────────────────
// Returns observations ASCENDING by date, with missing values ('.') removed.
async function fetchSeries(seriesId, startDate) {
  const url = `${FRED_BASE}?series_id=${seriesId}` +
              `&api_key=${FRED_KEY}` +
              `&file_type=json` +
              `&observation_start=${startDate}` +
              `&observation_end=${today()}` +
              `&sort_order=asc`;

  const res = await fetch(url);

  if (!res.ok) {
    // Surface the real reason. A 400 here almost always means a bad API key.
    const body = await res.text().catch(() => '');
    throw new Error(`FRED ${seriesId} returned HTTP ${res.status}. ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const obs = (json.observations || [])
    .filter(o => o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .filter(o => Number.isFinite(o.value));

  if (!obs.length) throw new Error(`FRED ${seriesId} returned no usable observations.`);

  console.log(`  ${seriesId}: ${obs.length} observations, latest ${obs[obs.length - 1].date} = ${obs[obs.length - 1].value}`);
  return obs;
}

// Most recent observation on or before a target date
function valueAsOf(obs, targetDate) {
  let match = null;
  for (const o of obs) {
    if (o.date <= targetDate) match = o;
    else break;
  }
  return match;
}

const latest = (obs) => obs[obs.length - 1];

// ── Streak helpers ───────────────────────────────────────────────────────

// Consecutive TRADING days (i.e. consecutive observations) at the end of the
// series for which predicate() is true.
function consecutiveObservations(obs, predicate) {
  let count = 0;
  for (let i = obs.length - 1; i >= 0; i--) {
    if (predicate(obs[i])) count++;
    else break;
  }
  return count;
}

// Consecutive CALENDAR days. Finds the most recent observation that FAILED the
// predicate and measures elapsed calendar days from it to the latest reading.
// If the condition currently fails, the streak is 0.
function consecutiveCalendarDays(obs, predicate) {
  if (!obs.length) return 0;
  const last = latest(obs);
  if (!predicate(last)) return 0;

  let lastFailDate = null;
  for (const o of obs) {
    if (!predicate(o)) lastFailDate = o.date;
  }

  // Never failed anywhere in our lookback window — count from the window start.
  if (!lastFailDate) return calendarDaysBetween(obs[0].date, last.date);

  return calendarDaysBetween(lastFailDate, last.date);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('Solyco Tilt Monitor — fetching FRED data...');

  const data = {
    generated: new Date().toISOString(),
    t1: null, t2: null, t3: null, t4: null, t5: null,
    errors: []
  };

  // ── T1 — INFLATION & RISING RATES ──────────────────────────────────────
  // CPIAUCSL (monthly index) + DGS10 (daily 10Y yield)
  try {
    const cpi = await fetchSeries('CPIAUCSL', daysAgo(500));
    const cpiNow = latest(cpi);

    // Find the reading ~12 months before the latest one
    const target = new Date(cpiNow.date + 'T00:00:00Z');
    target.setUTCFullYear(target.getUTCFullYear() - 1);
    const cpiPrior = valueAsOf(cpi, iso(target));

    if (!cpiPrior) throw new Error('CPIAUCSL: no reading ~12 months prior.');

    const cpiYoY = ((cpiNow.value - cpiPrior.value) / cpiPrior.value) * 100;

    const dgs10 = await fetchSeries('DGS10', daysAgo(400));
    const now10 = latest(dgs10);
    const ago10 = valueAsOf(dgs10, daysBefore(now10.date, 182)); // 6 months before the LATEST reading

    if (!ago10) throw new Error('DGS10: no reading ~6 months prior.');

    data.t1 = {
      cpiYoY: +cpiYoY.toFixed(3),
      cpiDate: cpiNow.date,
      dgs10: now10.value,
      dgs10Date: now10.date,
      dgs10Prior: ago10.value,
      dgs10PriorDate: ago10.date,
      riseBps: +((now10.value - ago10.value) * 100).toFixed(1)
    };
  } catch (e) {
    console.error('T1 FAILED:', e.message);
    errors.push('T1: ' + e.message);
  }

  // ── T2 — EQUITY BEAR MARKET ────────────────────────────────────────────
  // SP500 (daily close). Replaces the old Yahoo Finance call.
  // NOTE: FRED's SP500 series only carries ~10 years of history, which is
  // more than enough for a rolling 52-week high.
  try {
    const spx = await fetchSeries('SP500', daysAgo(900));

    // Rolling 52-week high at every point in the series, so we can determine
    // how long the index has ACTUALLY been in drawdown — not how many times
    // somebody happened to open the webpage.
    const enriched = spx.map((o, i) => {
      const windowStart = new Date(o.date + 'T00:00:00Z');
      windowStart.setUTCDate(windowStart.getUTCDate() - 365);
      const cutoff = iso(windowStart);

      let high = -Infinity;
      for (let j = i; j >= 0; j--) {
        if (spx[j].date < cutoff) break;
        if (spx[j].value > high) high = spx[j].value;
      }

      const drawdown = ((o.value - high) / high) * 100;
      return { ...o, high52w: high, drawdown, inDrawdown: drawdown <= -20.0 };
    });

    // Only count the streak once we have a full year of lookback behind us,
    // otherwise the earliest points have an artificially low 52w high.
    const usable = enriched.filter(o => o.date >= spx[0].date);
    const now = latest(usable);

    data.t2 = {
      close: +now.value.toFixed(2),
      closeDate: now.date,
      high52w: +now.high52w.toFixed(2),
      drawdown: +now.drawdown.toFixed(2),
      consecDays: consecutiveObservations(usable, o => o.inDrawdown)
    };
  } catch (e) {
    console.error('T2 FAILED:', e.message);
    errors.push('T2: ' + e.message);
  }

  // ── T3 — CREDIT STRESS ─────────────────────────────────────────────────
  // BAMLH0A0HYM2 — FRED reports this in PERCENT (e.g. 3.05 = 305bps).
  // We convert to basis points HERE, once, so the front-end never has to.
  try {
    const hy = await fetchSeries('BAMLH0A0HYM2', daysAgo(400));
    const hyNow = latest(hy);
    const hyPrior = valueAsOf(hy, daysBefore(hyNow.date, 60)); // 60 days before the LATEST reading

    if (!hyPrior) throw new Error('BAMLH0A0HYM2: no reading ~60 days prior.');

    const nowBps = hyNow.value * 100;
    const priorBps = hyPrior.value * 100;

    data.t3 = {
      oasBps: +nowBps.toFixed(1),
      oasDate: hyNow.date,
      oasPriorBps: +priorBps.toFixed(1),
      oasPriorDate: hyPrior.date,
      widenBps: +(nowBps - priorBps).toFixed(1)
    };
  } catch (e) {
    console.error('T3 FAILED:', e.message);
    errors.push('T3: ' + e.message);
  }

  // ── T4 — VOLATILITY SPIKE ──────────────────────────────────────────────
  // VIXCLS (daily VIX close). Replaces the old Yahoo Finance call.
  try {
    const vix = await fetchSeries('VIXCLS', daysAgo(400));
    const vixNow = latest(vix);

    data.t4 = {
      vix: +vixNow.value.toFixed(2),
      vixDate: vixNow.date,
      consecDays: consecutiveObservations(vix, o => o.value > 35)
    };
  } catch (e) {
    console.error('T4 FAILED:', e.message);
    errors.push('T4: ' + e.message);
  }

  // ── T5 — YIELD CURVE INVERSION ─────────────────────────────────────────
  // T10Y2Y. Spec calls for CALENDAR days, so we measure elapsed calendar time
  // since the last non-inverted reading. Lookback is long because inversions
  // can persist for well over a year.
  try {
    const curve = await fetchSeries('T10Y2Y', daysAgo(1200));
    const curveNow = latest(curve);

    data.t5 = {
      spread: +curveNow.value.toFixed(2),
      spreadDate: curveNow.date,
      consecDays: consecutiveCalendarDays(curve, o => o.value <= -0.25)
    };
  } catch (e) {
    console.error('T5 FAILED:', e.message);
    errors.push('T5: ' + e.message);
  }

  data.errors = errors;

  fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
  console.log('\nWrote data.json');
  console.log(JSON.stringify(data, null, 2));

  // If EVERY series failed, the run is broken (bad key, FRED down) — fail the
  // build so GitHub emails you rather than silently committing empty data.
  if (errors.length === 5) {
    console.error('\nFATAL: all five tilts failed to fetch. Check FRED_API_KEY.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
And the workflow file for Step 5 — filename .github/workflows/update-data.yml:
yamlname: Update Tilt Monitor Data

on:
  # Weekdays at 22:00 UTC (~6pm ET) — after the close, once FRED has posted.
  schedule:
    - cron: '0 22 * * 1-5'

  # Lets you click "Run workflow" in the Actions tab to refresh on demand.
  workflow_dispatch:

permissions:
  contents: write

jobs:
  update:
    runs-on: ubuntu-latest

    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Fetch FRED data and build data.json
        env:
          FRED_API_KEY: ${{ secrets.FRED_API_KEY }}
        run: node fetch-data.js

      - name: Commit data.json if it changed
        run: |
          git config user.name "Solyco Tilt Monitor"
          git config user.email "actions@github.com"
          git add data.json
          if git diff --staged --quiet; then
            echo "No change in data.json — nothing to commit."
          else
            git commit -m "Update tilt data — $(date -u '+%Y-%m-%d %H:%M UTC')"
            git push
          fi
