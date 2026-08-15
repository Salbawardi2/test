#!/usr/bin/env node

/**
 * Reviewer (alternate source)
 *
 * The primary site blocks seat-map requests with a hard bot-protection
 * challenge that a headless browser can't pass. One alternate booking site
 * fails with a "seat picker error" via a queue/waiting-room redirect. This
 * source sells the same showtimes and its seat-map data is reachable via
 * headless Chromium (though also protected against plain HTTP clients).
 *
 * This source's flow is click-driven, not a direct URL like the other
 * checker: venue page (with ?date=) -> showtime link -> "ADD" ticket ->
 * "Pick Seats", which returns an SVG seat map with clean attributes per
 * seat: seat-name="A23" is-available="true" seat-type="Standard"
 */

const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");

const VENUE_URL = "https://www.atomtickets.com/theaters/regal-hacienda-crossings/7207";
const MOVIE_TITLE = "The Odyssey";

// Weekends only, next ~5 weeks
const DATES = [
  "2026-08-15",
  "2026-08-16",
  "2026-08-22",
  "2026-08-23",
  "2026-08-29",
  "2026-08-30",
  "2026-09-05",
  "2026-09-06",
  "2026-09-12",
  "2026-09-13",
];

const SINGLE_RUN = process.argv.includes("--once");
const NTFY_TOPIC = "rc-seats-monitor";
const STATE_FILE = process.env.STATE_FILE || null;

// Screen 21 (IMAX 70mm), 253 seats: rows A-I, with C-G the widest (32 seats
// each) forming the main bowl. Middle-to-back-third + centered horizontally
// is the general large-format sweet spot (same logic as the other checker's god-tier pick):
// far enough back the screen doesn't overwhelm/cause neck strain, not so far
// it loses immersion. Rows E/F/G, centered on seats 14-20 of the 32-wide row.
const GOD_TIER_ROWS = new Set(["E", "F", "G"]);
const GOD_TIER_MIN = 14;
const GOD_TIER_MAX = 20;

function isDesiredSeat(seat) {
  if (!seat.name) return false;
  const row = seat.name.match(/^[A-Za-z]+/)?.[0];
  if (!row || !GOD_TIER_ROWS.has(row)) return false;
  const num = parseInt(seat.name.replace(/^[A-Za-z]+/, ""), 10);
  return num >= GOD_TIER_MIN && num <= GOD_TIER_MAX;
}

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
  const byRow = {};
  for (const s of seats) {
    if (!s.name) continue;
    const row = s.name.match(/^[A-Za-z]+/)?.[0];
    const num = parseInt(s.name.replace(/^[A-Za-z]+/, ""), 10);
    if (!row || Number.isNaN(num)) continue;
    if (!byRow[row]) byRow[row] = [];
    byRow[row].push({ name: s.name, row, num });
  }
  const pairs = [];
  for (const rowSeats of Object.values(byRow)) {
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
  return seats.map((s) => s.name).filter(Boolean).sort().join(", ");
}

// Parse the seat-map SVG fragment: each seat is a <g ... class="seat" ...> with
// seat-name, is-available, seat-type as plain attributes (no escaping/decoding needed).
function parseSeatMap(html) {
  const tagRe = /<g[^>]*class="seat"[^>]*>/g;
  const seats = [];
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const name = tag.match(/seat-name="([^"]+)"/)?.[1];
    const available = tag.match(/is-available="([^"]+)"/)?.[1] === "true";
    const type = tag.match(/seat-type="([^"]+)"/)?.[1] || "Standard";
    if (name) seats.push({ name, available, type });
  }
  return seats;
}

let browser = null;

async function getBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({ headless: true });
  return browser;
}

async function closeBrowser() {
  if (browser) await browser.close();
}

// Navigate the full click flow for one date and return [{ checkoutId, showtimeLabel, seatMapHtml }]
async function fetchShowtimesForDate(date) {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const results = [];

  try {
    await page.goto(`${VENUE_URL}?date=${date}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    // This source groups showtimes by format under one movie-title heading: an
    // unlabeled first group (IMAX 70mm) followed by an explicit "STANDARD
    // FORMAT" group. We only want the IMAX 70mm showtimes, so walk the DOM
    // in document order and stop collecting links once the "STANDARD
    // FORMAT" label is reached.
    const links = await page.evaluate((title) => {
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5"));
      const heading = headings.find((h) => h.textContent.trim() === title);
      if (!heading) return [];
      let container = heading.closest("section, article, div[class]") || heading.parentElement;
      for (let i = 0; i < 8 && container; i++) {
        if (container.querySelectorAll("a[href*='/checkout/']").length) break;
        container = container.parentElement;
      }
      if (!container) return [];

      const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
      const found = [];
      let hitStandard = false;
      let node = walker.currentNode;
      while (node) {
        if (!hitStandard && node.tagName === "A" && node.href && node.href.includes("/checkout/")) {
          found.push(node.href);
        }
        if ((node.textContent || "").trim() === "STANDARD FORMAT") hitStandard = true;
        node = walker.nextNode();
      }
      return found;
    }, MOVIE_TITLE);

    for (const link of links) {
      const showtimePage = await context.newPage();
      try {
        let seatMapHtml = null;
        showtimePage.on("response", async (res) => {
          if (res.url().includes("/seat-map?")) {
            try {
              seatMapHtml = await res.text();
            } catch {}
          }
        });

        await showtimePage.goto(link, { waitUntil: "domcontentloaded", timeout: 30000 });
        await showtimePage.waitForTimeout(3000);

        for (const btn of await showtimePage.$$("button")) {
          if ((await btn.innerText().catch(() => "")).trim() === "ADD") {
            await btn.click({ force: true }).catch(() => {});
            break;
          }
        }
        await showtimePage.waitForTimeout(1500);

        for (const btn of await showtimePage.$$("button")) {
          if ((await btn.innerText().catch(() => "")).trim() === "Pick Seats") {
            await btn.click({ force: true }).catch(() => {});
            break;
          }
        }
        await showtimePage.waitForTimeout(4000);

        const showtimeLabel = await showtimePage
          .evaluate(() => {
            const el = document.querySelector(".seat-map__show-datetime");
            return el ? el.textContent.trim() : null;
          })
          .catch(() => null);
        const screen = await showtimePage
          .evaluate(() => document.querySelector("[data-qa='SeatMap_AuditoriumId']")?.textContent.trim() || null)
          .catch(() => null);

        const checkoutId = link.split("/checkout/")[1];
        results.push({ checkoutId, showtimeLabel, screen, seatMapHtml });
      } catch (err) {
        console.log(`  Error on showtime ${link}: ${err.message}`);
      } finally {
        await showtimePage.close();
      }
    }
  } finally {
    await context.close();
  }

  return results;
}

async function checkDate(date) {
  console.log(`\n--- ${date} ---`);
  const showtimes = await fetchShowtimesForDate(date);

  if (showtimes.length === 0) {
    console.log(`  No "${MOVIE_TITLE}" showtimes found for this date.`);
    return;
  }

  for (const st of showtimes) {
    const { checkoutId, showtimeLabel, screen, seatMapHtml } = st;
    if (!seatMapHtml) {
      console.log(`  [${checkoutId}] Could not load seat map`);
      continue;
    }

    const seats = parseSeatMap(seatMapHtml);
    const available = seats.filter((s) => s.available);
    const label = `${MOVIE_TITLE}${screen ? " @ " + screen : ""}`;
    const timeLabel = showtimeLabel || "";

    const prev = previousState[checkoutId];
    const prevAvailable = prev ? prev.availableCount : -1;
    const newlyAvailable = [];
    if (prev) {
      const prevNames = new Set(prev.availableSeats.map((s) => s.name));
      for (const s of available) {
        if (!prevNames.has(s.name)) newlyAvailable.push(s);
      }
    }

    const change =
      prevAvailable === -1
        ? "(initial check)"
        : available.length > prevAvailable
          ? `\x1b[32m+${available.length - prevAvailable} NEW!\x1b[0m`
          : available.length < prevAvailable
            ? `\x1b[31m-${prevAvailable - available.length} taken\x1b[0m`
            : "(no change)";

    console.log(`\n  [${checkoutId}] ${label}${timeLabel ? " | " + timeLabel : ""}`);
    console.log(`    Available: ${available.length}/${seats.length} seats ${change}`);
    if (available.length > 0 && available.length <= 20) {
      console.log(`    Seats: ${formatSeatList(available)}`);
    }

    if (newlyAvailable.length > 0) {
      console.log(`\x1b[32m    >>> NEW SEATS OPENED UP: ${formatSeatList(newlyAvailable)} <<<\x1b[0m`);
    }

    // God-tier seats (rows E/F/G, seats 14-20) — same pattern as the other checker: only
    // alert on adjacent pairs, and only within the desired zone, otherwise a
    // mostly-empty showtime floods with meaningless "adjacent pair" noise.
    const desiredAvailable = available.filter(isDesiredSeat);
    if (desiredAvailable.length > 0) {
      console.log(`    God-tier seats (E/F/G 14-20): ${formatSeatList(desiredAvailable)}`);
    }
    const newPairsSource = prev ? newlyAvailable.filter(isDesiredSeat) : SINGLE_RUN ? desiredAvailable : [];
    const newPairs = findAdjacentPairs(newPairsSource);
    if (newPairs.length > 0) {
      console.log(`\x1b[32m    >>> ADJACENT PAIR ALERT: ${newPairs.join(", ")} <<<\x1b[0m`);
      notify(`RC Seats! ${label}`, `${timeLabel}\n${newPairs.join(", ")}`, VENUE_URL);
    }

    previousState[checkoutId] = { availableCount: available.length, availableSeats: available, label, timeLabel };
  }
}

async function main() {
  console.log("Reviewer");
  console.log(`Dates: ${DATES.join(", ")}`);

  loadState();
  for (const date of DATES) {
    await checkDate(date);
  }
  saveState();
  await closeBrowser();
}

main();
