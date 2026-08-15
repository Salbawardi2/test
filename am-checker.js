#!/usr/bin/env node

/**
 * Seat Availability Checker
 * Monitors seat availability for specified showtimes and alerts on changes.
 * Uses Playwright (real Chromium) to fetch pages, since the site sits behind
 * Cloudflare and blocks plain HTTP clients like curl.
 */

const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");

const SHOWTIME_IDS = [
  "145377421",
  "145377422",
  "145377423",
  "145377425",
  "145377426",
  "145377427",
  "145679721",
  "145681387",
  "145681388",
  "145681389",
  "145681390",
  "145681379",
  "145681380",
  "145681381",
  "145681364",
  "145681365",
  "145681366",
  "145681355",
  "145681356",
  "145681357",
  "145677338",
  "145681358",
  "145681331",
  "145681332",
  "145681333",
  "145681334",
  "145681335",
  "145681336",
  "145681325",
  "145681326",
  "145681318",
  "145681311",
  "145677340",
  "145681312",
];

const SHOWTIMES = SHOWTIME_IDS.map((id) => ({
  id,
  url: `https://www.amctheatres.com/showtimes/${id}/seats`,
}));

// Known desired seats already available — only alert on NEW ones beyond these
const KNOWN_DESIRED = Object.fromEntries(SHOWTIME_IDS.map((id) => [id, new Set([])]));

const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
const SINGLE_RUN = process.argv.includes("--once");
const NTFY_TOPIC = "am-seats-monitor";

// CI mode: a GitHub Actions job can't run forever, so it self-terminates after
// MAX_RUNTIME_SECONDS and persists previousState to STATE_FILE so the next
// scheduled run (5 min later) can still tell what's "newly available".
const MAX_RUNTIME_SECONDS = parseInt(process.env.MAX_RUNTIME_SECONDS || "0", 10);
const STATE_FILE = process.env.STATE_FILE || null;

// God-tier center seats: rows J, K, L, seats 15-20
const GOD_TIER_ROWS = new Set(["J", "K", "L"]);
const GOD_TIER_MIN = 15;
const GOD_TIER_MAX = 20;

function isDesiredSeat(seat) {
  if (!seat.name) return false;
  const row = seat.name[0];
  if (!GOD_TIER_ROWS.has(row)) return false;
  const num = parseInt(seat.name.slice(1), 10);
  return num >= GOD_TIER_MIN && num <= GOD_TIER_MAX;
}

// Track previous state for each showtime
let previousState = {};

function loadState() {
  if (!STATE_FILE) return;
  try {
    if (fs.existsSync(STATE_FILE)) {
      previousState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      console.log(`Loaded previous state from ${STATE_FILE}`);
    }
  } catch (err) {
    console.log(`Could not load state file: ${err.message}`);
  }
}

function saveState() {
  if (!STATE_FILE) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(previousState));
  } catch (err) {
    console.log(`Could not save state file: ${err.message}`);
  }
}

// Shared browser/context across checks so we're not paying startup cost every 30s
let browser = null;
let context = null;

async function getContext() {
  if (context) return context;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  return context;
}

async function fetchPage(url) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Give Cloudflare's JS challenge + the site's client-side render time to settle
    await page.waitForTimeout(3000);
    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browser) await browser.close();
}

function extractSeatingData(html) {
  // The HTML contains literal: seatingLayout\":{\"columns\":...
  // In JS string, backslash-quote is: \\"
  const marker = 'seatingLayout\\":{';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  // Find the matching closing brace by tracking depth from the opening {
  const start = idx + marker.length - 1; // point to the {
  let depth = 0;
  let end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }

  const raw = html.slice(start, end);
  // Unescape literal \" -> "
  const unescaped = raw.replace(/\\"/g, '"');
  return JSON.parse(unescaped);
}

function extractShowtimeInfo(html, showtimeId) {
  const info = {};

  // The HTML has literal \" as escape. In RegExp string, \\" matches literal \"
  const esc = '\\\\"'; // matches literal \"

  const perfRe = new RegExp(
    `timeId${esc}:${showtimeId},${esc}performanceNumber${esc}:(\\d+),${esc}showDateTimeUtc${esc}:${esc}([^\\\\]+)${esc}`
  );
  const perfMatch = html.match(perfRe);
  if (perfMatch) {
    info.performanceNumber = perfMatch[1];
    info.showDateTime = new Date(perfMatch[2]).toLocaleString();
  }

  const movieMatch = html.match(new RegExp(`movieName${esc}:${esc}([^\\\\]+)${esc}`));
  if (movieMatch) info.movieName = movieMatch[1];

  const theatreMatch = html.match(new RegExp(`theatreName${esc}:${esc}([^\\\\]+)${esc}`));
  if (theatreMatch) info.theatreName = theatreMatch[1];

  return info;
}

function analyzeSeats(seatingLayout) {
  const seats = seatingLayout.seats;
  const reservable = seats.filter(
    (s) => s.type !== "NotASeat" && s.shouldDisplay !== false
  );
  const available = seats.filter((s) => s.available === true);

  // Group available seats by tier
  const byTier = {};
  for (const s of available) {
    const tier = s.seatTier || "Unknown";
    if (!byTier[tier]) byTier[tier] = [];
    byTier[tier].push(s);
  }

  // Group available seats by row
  const byRow = {};
  for (const s of available) {
    const rowLetter = s.name ? s.name[0] : "?";
    if (!byRow[rowLetter]) byRow[rowLetter] = [];
    byRow[rowLetter].push(s);
  }

  return {
    totalDisplayable: reservable.length,
    availableCount: available.length,
    availableSeats: available,
    byTier,
    byRow,
  };
}

function notify(title, message, url) {
  try {
    execSync(
      `curl -s -d ${JSON.stringify(message)} -H ${JSON.stringify("Title: " + title)} -H "Priority: urgent" -H "Tags: ticket" -H ${JSON.stringify("Click: " + url)} https://ntfy.sh/${NTFY_TOPIC}`,
      { encoding: "utf8", timeout: 10000 }
    );
    console.log("  [ntfy] Notification sent!");
  } catch (err) {
    console.log("  [ntfy] Failed to send notification:", err.message);
  }
}

function findAdjacentPairs(seats) {
  // Group by row, then find consecutive seat numbers
  const byRow = {};
  for (const s of seats) {
    if (!s.name) continue;
    const row = s.name[0];
    const num = parseInt(s.name.slice(1), 10);
    if (!byRow[row]) byRow[row] = [];
    byRow[row].push({ name: s.name, row, num });
  }
  const pairs = [];
  for (const [row, rowSeats] of Object.entries(byRow)) {
    rowSeats.sort((a, b) => a.num - b.num);
    for (let i = 0; i < rowSeats.length - 1; i++) {
      if (rowSeats[i + 1].num - rowSeats[i].num === 1) {
        pairs.push(`${rowSeats[i].name}+${rowSeats[i + 1].name}`);
      }
    }
  }
  return pairs;
}

function formatSeatList(seats) {
  return seats
    .map((s) => s.name)
    .filter(Boolean)
    .sort()
    .join(", ");
}

async function checkShowtime(showtime) {
  const { id, url } = showtime;
  const timestamp = new Date().toLocaleTimeString();

  try {
    const html = await fetchPage(url);

    const seatingLayout = extractSeatingData(html);
    if (!seatingLayout) {
      console.log(
        `[${timestamp}] Showtime ${id}: Could not extract seat data (page may have changed format, showtime expired, or we got a Cloudflare block page)`
      );
      return;
    }

    const info = extractShowtimeInfo(html, id);
    const analysis = analyzeSeats(seatingLayout);

    const prev = previousState[id];
    const prevAvailable = prev ? prev.availableCount : -1;
    const newlyAvailable = [];

    if (prev) {
      const prevNames = new Set(prev.availableSeats.map((s) => s.name));
      for (const s of analysis.availableSeats) {
        if (!prevNames.has(s.name)) newlyAvailable.push(s);
      }
    }

    // Build status line
    const label = info.movieName
      ? `${info.movieName} @ ${info.theatreName || ""}`
      : `Showtime ${id}`;
    const showTime = info.showDateTime || "";
    const change =
      prevAvailable === -1
        ? "(initial check)"
        : analysis.availableCount > prevAvailable
          ? `\x1b[32m+${analysis.availableCount - prevAvailable} NEW!\x1b[0m`
          : analysis.availableCount < prevAvailable
            ? `\x1b[31m-${prevAvailable - analysis.availableCount} taken\x1b[0m`
            : "(no change)";

    console.log(
      `\n[${timestamp}] ${label}${showTime ? " | " + showTime : ""}`
    );
    console.log(
      `  Available: ${analysis.availableCount}/${analysis.totalDisplayable} seats ${change}`
    );

    // Show tier breakdown
    for (const [tier, seats] of Object.entries(analysis.byTier)) {
      console.log(`  ${tier}: ${seats.length} available (${formatSeatList(seats)})`);
    }

    // Show by row
    console.log("  By row:");
    for (const [row, seats] of Object.entries(analysis.byRow).sort()) {
      console.log(`    Row ${row}: ${formatSeatList(seats)}`);
    }

    // Highlight newly available seats
    if (newlyAvailable.length > 0) {
      const seatNames = formatSeatList(newlyAvailable);
      console.log(
        `\x1b[32m  >>> NEW SEATS OPENED UP: ${seatNames} <<<\x1b[0m`
      );
      console.log(`\x1b[32m  Book at: ${url}\x1b[0m`);
    }

    // Check god-tier seats (J/K/L, seats 15-20)
    const desiredAvailable = analysis.availableSeats.filter(isDesiredSeat);
    if (desiredAvailable.length > 0) {
      console.log(`  God-tier seats (J/K/L 15-20): ${formatSeatList(desiredAvailable)}`);
    }

    // Check for adjacent pairs in desired seats
    const adjacentPairs = findAdjacentPairs(desiredAvailable);
    if (adjacentPairs.length > 0) {
      console.log(`\x1b[32m  Adjacent pairs: ${adjacentPairs.join(", ")}\x1b[0m`);
    } else if (desiredAvailable.length > 0) {
      console.log(`  No adjacent pairs found in desired seats`);
    }

    // Notify for desired seats — only when adjacent pairs exist
    const known = KNOWN_DESIRED[id] || new Set();
    const desiredNew = prev
      ? newlyAvailable.filter(isDesiredSeat)
      : SINGLE_RUN ? desiredAvailable.filter(s => !known.has(s.name)) : [];
    const newPairs = findAdjacentPairs(desiredNew);
    if (newPairs.length > 0) {
      console.log(
        `\x1b[32m  >>> ADJACENT PAIR ALERT: ${newPairs.join(", ")} <<<\x1b[0m`
      );
      notify(
        `AM Seats! ${label}`,
        `${newPairs.join(", ")}\nGod-tier (J/K/L, 15-20)`,
        url
      );
    } else if (desiredNew.length > 0) {
      const seatNames = formatSeatList(desiredNew);
      console.log(
        `\x1b[32m  >>> DESIRED SEATS ALERT: ${seatNames} (no adjacent pairs) <<<\x1b[0m`
      );
    }

    if (analysis.availableCount === 0 && prevAvailable !== 0) {
      console.log(`  \x1b[33mSHOW IS SOLD OUT\x1b[0m`);
    }

    // Save state
    previousState[id] = analysis;
  } catch (err) {
    console.log(`[${timestamp}] Showtime ${id}: Error - ${err.message}`);
  }
}

async function checkAll() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Seat Check - ${new Date().toLocaleString()}`);
  console.log("=".repeat(60));

  for (const showtime of SHOWTIMES) {
    await checkShowtime(showtime);
  }
  saveState();
}

async function main() {
  const singleRun = process.argv.includes("--once");

  console.log("Reviewer");
  if (singleRun) {
    console.log("Single run mode (--once)");
  } else if (MAX_RUNTIME_SECONDS > 0) {
    console.log(
      `CI mode: checking every ${CHECK_INTERVAL_MS / 1000}s for up to ${MAX_RUNTIME_SECONDS}s, then exiting`
    );
  } else {
    console.log(`Checking ${SHOWTIMES.length} showtimes every ${CHECK_INTERVAL_MS / 1000}s`);
    console.log("\nPress Ctrl+C to stop.\n");
  }
  console.log("URLs:");
  for (const s of SHOWTIMES) console.log(`  ${s.url}`);

  loadState();
  await checkAll();

  if (singleRun) {
    await closeBrowser();
    return;
  }

  // Schedule recurring checks
  const interval = setInterval(checkAll, CHECK_INTERVAL_MS);
  const shutdown = async () => {
    clearInterval(interval);
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  if (MAX_RUNTIME_SECONDS > 0) {
    setTimeout(shutdown, MAX_RUNTIME_SECONDS * 1000);
  }
}

main();
