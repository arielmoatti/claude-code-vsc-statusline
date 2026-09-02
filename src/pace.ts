// Weekly burn-pace estimator.
//
// The status bar already answers "how much have I used". This answers the
// question that actually drives planning: *at the rate I am working, do I run
// out of weekly quota before it resets?*
//
// The naive way to answer it is `utilization ÷ fraction of the week elapsed`.
// That reading is wrong in a specific and dangerous way: weekly quota accrues
// on wall-clock time, but you only burn it while you work. Sleep eight hours
// and the naive number improves on its own, so the same 14% reads 152% at
// midnight and 102% at breakfast — it tells you to relax precisely when
// nothing has changed.
//
// So the rate here is measured per hour *of actual work*, recovered from the
// sample history: an interval counts as work only if weekly utilization moved
// during it. That number is stable across a night's sleep.
//
// This module is deliberately free of any vscode import so it can be unit
// tested in plain node.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const HISTORY_PATH = path.join(os.tmpdir(), 'claude', 'statusline-usage-history.jsonl');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// A gap longer than this cannot honestly be called work time: nothing was
// sampling, so we do not know when inside it the quota moved. The interval
// still contributes its burn, but only this much attributed work time — which
// biases the rate upward (redder), the safe direction.
const ACTIVE_GAP_CAP_MS = 20 * 60 * 1000;

// Below this much recorded work time, a rate is noise, not a measurement.
const MIN_ACTIVE_MS = 3 * HOUR_MS;

// Nothing at all can be said before the week has run this long.
const MIN_ELAPSED_MS = 30 * 60 * 1000;

// The share of wall-clock time spent working can only be measured over a span
// that contains at least one full day/night cycle. Anything shorter is biased
// by whichever part of the day it happens to cover — an evening-only history
// would claim the user works 44% of every week.
const MIN_COVERAGE_MS = 24 * HOUR_MS;
const DEFAULT_ACTIVE_FRACTION = 0.30;
const MIN_ACTIVE_FRACTION = 0.05;

const HISTORY_KEEP_MS = 21 * 24 * 60 * 60 * 1000;
const PRUNE_AT_BYTES = 2 * 1024 * 1024;
const TAIL_READ_BYTES = 4096;

export interface Sample {
  t: number;  // epoch ms of the sensor reading (shared cache `fetchedAt`)
  w: number;  // seven_day utilization %
  h: number;  // five_hour utilization %
  r?: number; // epoch ms of the weekly resets_at this reading belonged to
}

export type PaceLevel = 'green' | 'orange' | 'red';

export interface Pace {
  landing: number;              // projected seven_day utilization at reset, %
  level: PaceLevel;
  dryAt: number | null;         // epoch ms the quota hits 100%, null if it never does
  provisional: boolean;         // true = no usable history yet, wall-clock estimate
  ratePerActiveHour: number;    // % of weekly quota burned per hour of work
  activeHours: number;          // hours of work recorded this week
  activeFraction: number;       // share of wall-clock time spent working
}

// ── Recording ──

export function recordSample(
  fetchedAt: number,
  weeklyPct: number,
  fiveHourPct: number,
  weekResetsAtMs?: number,
): void {
  try {
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) { return; }
    if (!Number.isFinite(weeklyPct)) { return; }

    // Every window reads the same shared cache, so `fetchedAt` is a natural
    // dedup key: whichever instance sees a new sensor reading first records it.
    const last = lastRecordedT();
    if (last !== null && fetchedAt <= last) { return; }

    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    const row: Sample = {
      t: Math.round(fetchedAt),
      w: round2(weeklyPct),
      h: round2(Number.isFinite(fiveHourPct) ? fiveHourPct : 0),
    };
    // Recording which weekly window a reading belonged to is what lets the
    // estimator tell a real reset apart from the server revising the number
    // downward mid-week. Guessing from the value alone cannot: 6% dropping to
    // 2% looks exactly like a reset if you only watch the percentage.
    if (Number.isFinite(weekResetsAtMs)) { row.r = Math.round(weekResetsAtMs as number); }
    const line = JSON.stringify(row);
    fs.appendFileSync(HISTORY_PATH, line + '\n');
    maybePrune();
  } catch { /* history is best-effort; the status bar must never break over it */ }
}

function lastRecordedT(): number | null {
  try {
    const fd = fs.openSync(HISTORY_PATH, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) { return null; }
      const len = Math.min(TAIL_READ_BYTES, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = parseLine(lines[i]);
        if (s) { return s.t; }
      }
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function maybePrune(): void {
  try {
    if (fs.statSync(HISTORY_PATH).size < PRUNE_AT_BYTES) { return; }
    const cutoff = Date.now() - HISTORY_KEEP_MS;
    const kept = fs.readFileSync(HISTORY_PATH, 'utf8')
      .split('\n')
      .filter(l => { const s = parseLine(l); return s !== null && s.t >= cutoff; });
    const tmp = HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + '\n');
    fs.renameSync(tmp, HISTORY_PATH);
  } catch { /* best-effort */ }
}

// ── Reading ──

export function readHistory(sinceT: number, historyPath: string = HISTORY_PATH): Sample[] {
  let raw: string;
  try { raw = fs.readFileSync(historyPath, 'utf8'); } catch { return []; }

  const byT = new Map<number, Sample>();
  for (const line of raw.split('\n')) {
    const s = parseLine(line);
    if (s && s.t >= sinceT) { byT.set(s.t, s); }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function parseLine(line: string): Sample | null {
  const trimmed = line.trim();
  if (!trimmed) { return null; }
  try {
    const o = JSON.parse(trimmed);
    if (!Number.isFinite(o?.t) || !Number.isFinite(o?.w)) { return null; }
    const s: Sample = { t: o.t, w: o.w, h: Number.isFinite(o.h) ? o.h : 0 };
    if (Number.isFinite(o.r)) { s.r = o.r; }
    return s;
  } catch { return null; }
}

// ── Measurement ──

interface Span {
  burn: number;
  activeMs: number;
  coveredMs: number;  // wall-clock actually spanned by samples, not the window width
  samples: number;
}

// Walks consecutive samples inside a span.
//
// Work time comes from intervals where weekly utilization rose.
//
// Burn is measured as the NET change inside each weekly window, not as the sum
// of every upward tick. That distinction is not academic: the server can revise
// the weekly figure downward mid-window (observed 01.09.2026, 6% → 2% with the
// reset timestamp unchanged and the user working throughout). Summing upward
// ticks would keep the inflated reading in the total and silently ignore the
// correction, so every such episode would leave the estimated rate permanently
// too high. Net-per-window absorbs it.
//
// Telling a revision from a real reset needs the window identity, which is why
// samples carry `r`. Rows written before that field existed fall back to the
// old upward-tick sum.
export function measureSpan(samples: Sample[], fromT: number, toT: number): Span {
  const inSpan = samples.filter(s => s.t >= fromT && s.t <= toT);

  let activeMs = 0;
  for (let i = 1; i < inSpan.length; i++) {
    const dt = inSpan[i].t - inSpan[i - 1].t;
    if (dt <= 0) { continue; }
    if (inSpan[i].w > inSpan[i - 1].w) { activeMs += Math.min(dt, ACTIVE_GAP_CAP_MS); }
  }

  const windowed = inSpan.length > 0 && inSpan.every(s => s.r !== undefined);
  let burn = 0;

  if (windowed) {
    let segFirst: Sample | null = null;
    let segLast: Sample | null = null;
    for (const s of inSpan) {
      if (segFirst === null || s.r !== segFirst.r) {
        if (segFirst && segLast) { burn += Math.max(0, segLast.w - segFirst.w); }
        segFirst = s;
      }
      segLast = s;
    }
    if (segFirst && segLast) { burn += Math.max(0, segLast.w - segFirst.w); }
  } else {
    for (let i = 1; i < inSpan.length; i++) {
      const dw = inSpan[i].w - inSpan[i - 1].w;
      if (dw > 0 && inSpan[i].t > inSpan[i - 1].t) { burn += dw; }
    }
  }

  const coveredMs = inSpan.length >= 2 ? inSpan[inSpan.length - 1].t - inSpan[0].t : 0;
  return { burn, activeMs, coveredMs, samples: inSpan.length };
}

// ── Projection ──

export function computePace(
  weeklyPct: number,
  weekResetsAtMs: number,
  now: number,
  samples?: Sample[],
): Pace | null {
  if (!Number.isFinite(weeklyPct) || !Number.isFinite(weekResetsAtMs)) { return null; }

  const weekStart = weekResetsAtMs - WEEK_MS;
  const elapsedMs = now - weekStart;
  const remainingMs = weekResetsAtMs - now;
  if (elapsedMs < MIN_ELAPSED_MS || remainingMs <= 0) { return null; }

  const hist = samples ?? readHistory(now - 3 * WEEK_MS);
  const thisWeek = measureSpan(hist, weekStart, now);
  const trailing = measureSpan(hist, now - WEEK_MS, now);

  // How much of the wall clock this user actually works. Measured over the
  // trailing seven days so it survives the reset boundary, which is exactly
  // when this week's own sample count is too small to say anything.
  //
  // Divide by the span the samples actually cover, NOT by the window width:
  // a history that is only 13 hours old has not observed a night yet, and
  // dividing 6 recorded work hours by a full 168 would claim this user works
  // 3.6% of the week and paint every runaway pace green.
  let activeFraction = DEFAULT_ACTIVE_FRACTION;
  if (trailing.coveredMs >= MIN_COVERAGE_MS && trailing.activeMs > 0) {
    activeFraction = trailing.activeMs / trailing.coveredMs;
  }
  activeFraction = Math.min(1, Math.max(MIN_ACTIVE_FRACTION, activeFraction));

  let ratePerActiveHour: number;
  let provisional: boolean;

  if (thisWeek.activeMs >= MIN_ACTIVE_MS && thisWeek.burn > 0) {
    ratePerActiveHour = thisWeek.burn / (thisWeek.activeMs / HOUR_MS);
    provisional = false;
  } else if (trailing.activeMs >= MIN_ACTIVE_MS && trailing.burn > 0) {
    // Early in the week: keep using the rhythm the previous days established
    // rather than dividing by a denominator of a few hours.
    ratePerActiveHour = trailing.burn / (trailing.activeMs / HOUR_MS);
    provisional = false;
  } else {
    // Cold start — the history file is new or empty. Fall back to the
    // wall-clock average, re-expressed per active hour so the projection below
    // stays one formula. Algebraically this reproduces the naive number
    // exactly, which is why it is flagged provisional.
    const wallRatePerHour = weeklyPct / (elapsedMs / HOUR_MS);
    ratePerActiveHour = wallRatePerHour / activeFraction;
    provisional = true;
  }

  const futureActiveHours = activeFraction * (remainingMs / HOUR_MS);
  const landing = weeklyPct + futureActiveHours * ratePerActiveHour;

  let dryAt: number | null = null;
  if (landing > 100 && ratePerActiveHour > 0 && weeklyPct < 100) {
    const activeHoursLeft = (100 - weeklyPct) / ratePerActiveHour;
    dryAt = now + (activeHoursLeft / activeFraction) * HOUR_MS;
  } else if (weeklyPct >= 100) {
    dryAt = now;
  }

  return {
    landing,
    level: levelFor(landing),
    dryAt,
    provisional,
    ratePerActiveHour,
    activeHours: thisWeek.activeMs / HOUR_MS,
    activeFraction,
  };
}

// Thresholds are derived from the consequence, not picked for roundness.
// A landing of L% runs the quota dry at 100/L of the way through the week,
// i.e. 168 × (1 − 100/L) hours before the reset:
//   105% →  8h early     115% → 22h early     150% → 56h early
// So 115 is the line between losing an evening and losing a full working day.
export function levelFor(landing: number): PaceLevel {
  if (landing < 100) { return 'green'; }
  if (landing < 115) { return 'orange'; }
  return 'red';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
