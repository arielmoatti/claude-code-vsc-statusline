import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import { execFileSync, execFile } from 'child_process';

// ── Types ──

interface PeakConfig {
  enabled: boolean;
  tz: string;
  days: number[];
  start: number;
  end: number;
  label_peak: string;
  label_offpeak: string;
}

interface Schedule {
  v: number;
  mode: string;
  peak: PeakConfig;
}

interface ExtraUsage {
  is_enabled?: boolean;
  used_credits?: number;
  monthly_limit?: number;
}

interface UsageData {
  five_hour?: { utilization: number; reset_at?: string; resets_at?: string };
  seven_day?: { utilization: number; reset_at?: string; resets_at?: string };
  extra_usage?: ExtraUsage;
}

interface UsageResult {
  data: UsageData | null;
  error?: string;
}

interface SharedState {
  data: UsageData | null;
  fetchedAt: number;
  nextAllowedAt: number;
  lockPid: number;
  lockAt: number;
}

// ── Constants ──

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CREDENTIALS_PATH = path.join(CLAUDE_DIR, '.credentials.json');
const SCHEDULE_CACHE_PATH = path.join(CLAUDE_DIR, 'statusline-schedule.json');
const USAGE_CACHE_PATH = path.join(os.tmpdir(), 'claude', 'statusline-usage-cache.json');

// Shared-state tuning. All instances read/write USAGE_CACHE_PATH as a coordination point.
const FRESH_TTL_MS = 60_000;            // served without any HTTP
const LOCK_TTL_MS = 10_000;             // another instance is mid-flight
const BACKOFF_RATE_LIMIT_MS = 15 * 60_000; // on HTTP 429 when no Retry-After
const BACKOFF_RATE_LIMIT_MIN_MS = 2 * 60_000;   // floor for parsed Retry-After
const BACKOFF_RATE_LIMIT_MAX_MS = 15 * 60_000;  // ceiling for parsed Retry-After
const BACKOFF_ERROR_MS = 2 * 60_000;    // on other errors
const BACKOFF_AUTH_ERROR_MS = 30_000;   // brief pause while claude update runs
const JITTER_RATIO = 0.25;              // ±25% on refresh interval
const STALE_POLL_SEC = 30;              // faster cadence once cached reset_at elapsed
const POLL_FAST_SEC = 60;               // burst interval when usage is climbing
const POLL_FAST_EXTRA = 3;              // how many fast ticks to run per burst
const NEAR_RESET_MIN = 15;              // red→orange grace window in minutes
const RESET_ALIGN_WINDOW = 1.5;         // trigger reset alignment when next reset < interval × this
const RESET_ALIGN_BUFFER_MS = 5_000;    // poll this long after resets_at

const SCHEDULE_URL = 'https://raw.githubusercontent.com/Nadav-Fux/claude-2x-statusline/main/schedule.json';

const DEFAULT_SCHEDULE: Schedule = {
  v: 2, mode: 'peak_hours',
  peak: {
    enabled: true, tz: 'America/Los_Angeles',
    days: [1, 2, 3, 4, 5], start: 5, end: 11,
    label_peak: 'Peak', label_offpeak: 'Off-Peak',
  },
};

// Anthropic bills eurozone accounts in €, UK accounts in £, everywhere else
// (including Israel) in $. Windows locale provides the country code; the
// billing currency does not always match the OS display currency (e.g. an
// Israeli user whose Windows is set to ₪ is still billed in $).
const EUROZONE_COUNTRIES = new Set([
  'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
]);

// ── State ──

let peakItem: vscode.StatusBarItem;
let fhItem: vscode.StatusBarItem;
let wdItem: vscode.StatusBarItem;
let extraItem: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let cachedSchedule: Schedule | null = null;
let cachedCurrencySymbol: string | null = null;

// Activity-adaptive polling state
let prevUtilFiveHour: number | null = null;
let prevUtilSevenDay: number | null = null;
let fastPollsRemaining = 0;

// Token refresh state
let tokenRefreshInFlight = false;
let lastFailedToken: string | null = null;

// ── API-key detection ──

function isApiKeyWorkspace(): boolean {
  const envVars = vscode.workspace.getConfiguration('claude-code')
    .get<Array<{ name: string; value: string }>>('environmentVariables', []);
  if (envVars.some(v => v.name === 'ANTHROPIC_API_KEY' && v.value)) { return true; }

  if (process.env.ANTHROPIC_API_KEY) { return true; }

  return false;
}

// ── Activation ──

export function activate(context: vscode.ExtensionContext) {
  if (isApiKeyWorkspace()) { return; }

  peakItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 201);
  fhItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  wdItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 199);
  extraItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 198);

  context.subscriptions.push(peakItem, fhItem, wdItem, extraItem);
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeStatusline.refresh', () => refresh())
  );

  const scheduleNext = () => {
    const configured = vscode.workspace.getConfiguration('claudeStatusline').get<number>('refreshInterval', 120);
    const state = readSharedState();

    // Three factors decide the base cadence, in priority order:
    //   1. Cached reset_at elapsed  → poll fast (API often lags, we want to catch the drop)
    //   2. Activity burst active    → POLL_FAST_SEC (user is actively burning quota)
    //   3. Otherwise                → configured interval
    let intervalSec: number;
    if (isUsagePastReset(state.data)) {
      intervalSec = Math.min(STALE_POLL_SEC, configured);
    } else if (fastPollsRemaining > 0) {
      intervalSec = Math.min(POLL_FAST_SEC, configured);
    } else {
      intervalSec = configured;
    }

    let delayMs: number;
    const alignedDelay = resetAlignedDelay(state.data, intervalSec * 1000);
    if (alignedDelay !== null) {
      // Reset is close enough that the next regular tick would arrive late.
      // Skip jitter — we want this one to hit right after the reset boundary.
      delayMs = alignedDelay;
    } else {
      const baseMs = intervalSec * 1000;
      const jitter = baseMs * JITTER_RATIO * (Math.random() * 2 - 1);
      delayMs = Math.max(1000, Math.round(baseMs + jitter));
    }

    refreshTimer = setTimeout(async () => {
      await refresh();
      scheduleNext();
    }, delayMs);
  };

  refresh().finally(scheduleNext);
}

export function deactivate() {
  if (refreshTimer) { clearTimeout(refreshTimer); }
}

// ── Main refresh ──

async function refresh() {
  try {
    const vsConfig = vscode.workspace.getConfiguration('claudeStatusline');
    const schedule = await loadSchedule();
    cachedSchedule = schedule;

    updatePeakItem(schedule, vsConfig.get<boolean>('showPeakHours', true));
    await updateRateLimitItems(vsConfig.get<boolean>('showRateLimits', true));
  } catch { /* statusline is non-critical */ }
}

// ── Schedule ──

async function loadSchedule(): Promise<Schedule> {
  try {
    const stat = fs.statSync(SCHEDULE_CACHE_PATH);
    if ((Date.now() - stat.mtimeMs) / 3_600_000 < 6) {
      return JSON.parse(fs.readFileSync(SCHEDULE_CACHE_PATH, 'utf8'));
    }
  } catch { /* no cache */ }

  try {
    const data = await httpGet(SCHEDULE_URL);
    const schedule = JSON.parse(data);
    fs.writeFileSync(SCHEDULE_CACHE_PATH, JSON.stringify(schedule, null, 2));
    return schedule;
  } catch { /* fetch failed */ }

  try { return JSON.parse(fs.readFileSync(SCHEDULE_CACHE_PATH, 'utf8')); }
  catch { /* no stale cache */ }

  return DEFAULT_SCHEDULE;
}

// ── Peak Hours ──

function updatePeakItem(schedule: Schedule, show: boolean) {
  if (!show || schedule.mode === 'normal') { peakItem.hide(); return; }

  const peak = schedule.peak;
  if (!peak?.enabled) {
    peakItem.text = '$(check) Off-Peak';
    peakItem.backgroundColor = undefined;
    peakItem.color = new vscode.ThemeColor('statusBarItem.foreground');
    peakItem.show();
    return;
  }

  const now = new Date();
  const localOffset = -now.getTimezoneOffset() / 60;
  const hour = now.getHours() + now.getMinutes() / 60;
  const weekday = now.getDay() === 0 ? 7 : now.getDay();

  const peakDays = peak.days;
  const { startLocal, endLocal } = peakHoursToLocal(schedule, localOffset);

  const isPeakDay = peakDays.includes(weekday);
  const prevWeekday = weekday === 1 ? 7 : weekday - 1;
  const prevWasPeak = peakDays.includes(prevWeekday);
  let isPeak = false;
  let minsLeft = 0;
  let minsUntil = 0;

  if (isPeakDay || prevWasPeak) {
    if (endLocal > startLocal) {
      if (isPeakDay) { isPeak = hour >= startLocal && hour < endLocal; }
      if (isPeak) { minsLeft = Math.floor((endLocal - hour) * 60); }
      else if (isPeakDay && hour < startLocal) { minsUntil = Math.floor((startLocal - hour) * 60); }
      else { minsUntil = minsUntilNextPeak(now, peakDays, startLocal); }
    } else {
      if (isPeakDay && hour >= startLocal) { isPeak = true; }
      else if (prevWasPeak && hour < endLocal) { isPeak = true; }
      if (isPeak) {
        minsLeft = hour >= startLocal
          ? Math.floor((24 - hour + endLocal) * 60)
          : Math.floor((endLocal - hour) * 60);
      } else {
        minsUntil = (isPeakDay && hour < startLocal)
          ? Math.floor((startLocal - hour) * 60)
          : minsUntilNextPeak(now, peakDays, startLocal);
      }
    }
  } else {
    minsUntil = minsUntilNextPeak(now, peakDays, startLocal);
  }

  const labelPeak = peak.label_peak || 'Peak';
  const labelOff = peak.label_offpeak || 'Off-Peak';
  const rangeStr = `${fmtHour(startLocal)}-${fmtHour(endLocal)}`;

  if (isPeak) {
    if (minsLeft > 0 && minsLeft <= 30) {
      peakItem.text = `$(flame) ${labelPeak} — ${fmtDuration(minsLeft)} left (${rangeStr})`;
      peakItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      peakItem.text = `$(flame) ${labelPeak}`;
      peakItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    peakItem.color = undefined;
    peakItem.tooltip = '';
    peakItem.show();
  } else {
    if (minsUntil > 0 && minsUntil <= 60) {
      peakItem.text = `$(check) ${labelOff} — peak in ${fmtDuration(minsUntil)} (${rangeStr})`;
      peakItem.tooltip = '';
    } else {
      peakItem.text = `$(check) ${labelOff}`;
      peakItem.tooltip = '';
    }
    peakItem.backgroundColor = undefined;
    peakItem.color = '#4ec9b0';
    peakItem.show();
  }
}

// ── Rate Limits ──

async function updateRateLimitItems(show: boolean) {
  if (!show) { fhItem.hide(); wdItem.hide(); extraItem.hide(); return; }

  const result = await fetchUsage();
  const usage = applyFakeOverrides(result.data);

  if (!usage) {
    if (result.error) {
      const code = result.error.replace('HTTP ', '');
      fhItem.text = `$(error) Usage: ${code}`;
      fhItem.color = '#f14c4c';
      fhItem.backgroundColor = undefined;
      fhItem.tooltip = result.error;
      fhItem.show();
    } else {
      fhItem.hide();
    }
    wdItem.hide();
    extraItem.hide();
    return;
  }

  const fh = usage.five_hour;
  const wd = usage.seven_day;

  // Activity-adaptive polling: a rise in utilization triggers a burst of faster
  // polls. Only the 5h quota triggers this — 7d barely moves on a single-session
  // timescale. Never fast-poll when a backoff window is active (the scheduler
  // checks shared state before each tick).
  const fhPct = Math.round(fh?.utilization ?? 0);
  const wdPct = Math.round(wd?.utilization ?? 0);
  if (prevUtilFiveHour !== null && fhPct > prevUtilFiveHour) {
    fastPollsRemaining = POLL_FAST_EXTRA;
  } else if (fastPollsRemaining > 0) {
    fastPollsRemaining -= 1;
  }
  prevUtilFiveHour = fhPct;
  prevUtilSevenDay = wdPct;

  updateLimitItem(fhItem, '5h', fhPct, fh?.resets_at ?? fh?.reset_at,
    '#3dc9b0', '#e8ab3a', '#f14c4c');
  if (wdPct >= 50) {
    updateLimitItem(wdItem, '7d', wdPct, wd?.resets_at ?? wd?.reset_at,
      '#b4a0ff', '#d4a0ff', '#f14c4c');
  } else {
    wdItem.hide();
  }

  // Surface extra_usage only when regular quota is actually exhausted.
  // Having overage enabled is a permanent account setting; residual spend
  // from earlier in the month is not news. What matters is whether you're
  // burning extra *right now*, which only happens once 5h or 7d hits 100%.
  const inOverage = (fhPct >= 100) || (wdPct >= 100);
  updateExtraUsageItem(inOverage ? usage.extra_usage : undefined);
}

function updateLimitItem(item: vscode.StatusBarItem, label: string, pct: number,
  resetAt: string | undefined, colorLow: string, colorMid: string, colorHigh: string) {
  const bar = batteryBar(pct);
  // Clock time only when reset is within 24h — past that, "at 12:00"
  // is noise because it doesn't say which day.
  let resetStr = '';
  if (resetAt) {
    const msUntil = new Date(resetAt).getTime() - Date.now();
    const within24h = msUntil > 0 && msUntil < 24 * 60 * 60 * 1000;
    const clock = within24h ? ` (${fmtClockTime(resetAt)})` : '';
    resetStr = ` ⟳${fmtResetTime(resetAt).replace('in ', '')}${clock}`;
  }

  // Near-reset grace: if the cap is minutes away, downgrade red → orange.
  // Spares the panic when you've hit 80%+ and the window is about to reset anyway.
  const minsLeft = resetAt ? (new Date(resetAt).getTime() - Date.now()) / 60_000 : Infinity;
  const nearReset = minsLeft >= 0 && minsLeft < NEAR_RESET_MIN;

  const icon = (pct >= 80 && !nearReset) ? '$(warning) ' : '';
  const color = (pct >= 80 && !nearReset) ? colorHigh : pct >= 50 ? colorMid : colorLow;

  item.text = `${icon}${label} | ${pct}% ${bar}${resetStr}`;
  item.color = color;
  item.backgroundColor = undefined;
  item.tooltip = '';
  item.show();
}

function updateExtraUsageItem(extra: ExtraUsage | undefined) {
  if (!extra || !extra.is_enabled || !extra.monthly_limit || extra.monthly_limit <= 0) {
    extraItem.hide();
    return;
  }
  const usedRaw = extra.used_credits ?? 0;
  if (usedRaw <= 0) { extraItem.hide(); return; }

  // API returns amounts in minor units (cents). 10000 = 100.00 in the user's currency.
  const used = usedRaw / 100;
  const limit = extra.monthly_limit / 100;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const bar = batteryBar(pct);
  const symbol = getCurrencySymbol();
  const fmt = (n: number) => `${symbol}${n.toFixed(2)}`;

  extraItem.text = `$(credit-card) ${bar} ${fmt(used)} / ${fmt(limit)}`;
  extraItem.color = '#e05c5c';
  extraItem.backgroundColor = undefined;
  extraItem.tooltip = `Extra usage: ${fmt(used)} of ${fmt(limit)} monthly (${pct}%)`;
  extraItem.show();
}

function batteryBar(pct: number): string {
  const width = 8;
  const filled = Math.round(pct * width / 100);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Currency detection ──

function getCurrencySymbol(): string {
  if (cachedCurrencySymbol !== null) { return cachedCurrencySymbol; }

  const override = vscode.workspace.getConfiguration('claudeStatusline').get<string>('currencySymbol', '');
  if (override) {
    cachedCurrencySymbol = override;
    return override;
  }

  cachedCurrencySymbol = detectCurrencyFromLocale();
  return cachedCurrencySymbol;
}

function detectCurrencyFromLocale(): string {
  if (process.platform !== 'win32') { return '$'; }
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true },
    );
    const match = out.match(/LocaleName\s+REG_SZ\s+(\S+)/);
    const localeName = match?.[1] ?? 'en-US';
    const country = (localeName.split('-')[1] ?? 'US').toUpperCase();
    return currencyForCountry(country);
  } catch {
    return '$';
  }
}

function currencyForCountry(country: string): string {
  // Anthropic billing-currency heuristic; not country's local currency.
  // Israel is explicitly forced to USD even though Windows may report ₪.
  if (country === 'IL') { return '$'; }
  if (EUROZONE_COUNTRIES.has(country)) { return '€'; }
  if (country === 'GB') { return '£'; }
  return '$';
}

// ── Fake overrides (debug/QA) ──
//
// Per-field shallow merge. Each key replaces that field entirely when present.
// Example settings.json:
//   "claudeStatusline._fakeOverrides": {
//     "seven_day": { "utilization": 62, "resets_at": "2026-04-30T10:00:00Z" }
//   }

function applyFakeOverrides(data: UsageData | null): UsageData | null {
  if (!data) { return data; }
  const overrides = vscode.workspace.getConfiguration('claudeStatusline').get<Record<string, unknown> | null>('_fakeOverrides', null);
  if (!overrides || typeof overrides !== 'object') { return data; }
  const merged: UsageData = { ...data };
  for (const key of ['five_hour', 'seven_day', 'extra_usage'] as const) {
    const val = overrides[key];
    if (val && typeof val === 'object') {
      (merged as Record<string, unknown>)[key] = { ...(data[key] ?? {}), ...(val as object) };
    }
  }
  return merged;
}

// ── Usage fetch ──
//
// Coordination model: every VS Code instance shares a single state file at
// USAGE_CACHE_PATH. Before making any HTTP call, an instance reads the file
// and honors three gates:
//   1. Fresh data     → return cached, no HTTP at all
//   2. Back-off active → return stale data (or error), no HTTP
//   3. Lock active    → another instance is mid-flight, skip this tick
// This makes N instances behave like 1 when it comes to API pressure, and
// ensures a 429 response pauses every window at once.

function isUsagePastReset(usage: UsageData | null): boolean {
  if (!usage) { return false; }
  const resets = [
    usage.five_hour?.resets_at ?? usage.five_hour?.reset_at,
    usage.seven_day?.resets_at ?? usage.seven_day?.reset_at,
  ];
  const now = Date.now();
  return resets.some(r => {
    if (!r) { return false; }
    const t = new Date(r).getTime();
    return Number.isFinite(t) && t <= now;
  });
}

function resetAlignedDelay(usage: UsageData | null, intervalMs: number): number | null {
  // If the next quota reset is within RESET_ALIGN_WINDOW × intervalMs,
  // schedule the next poll for the reset moment + buffer rather than letting
  // the regular tick overshoot it.
  if (!usage) { return null; }
  const nextReset = earliestUpcomingReset(usage);
  if (nextReset === null) { return null; }
  const msUntil = nextReset - Date.now();
  if (msUntil <= 0) { return null; }
  if (msUntil + RESET_ALIGN_BUFFER_MS <= intervalMs * RESET_ALIGN_WINDOW) {
    return msUntil + RESET_ALIGN_BUFFER_MS;
  }
  return null;
}

function earliestUpcomingReset(usage: UsageData): number | null {
  const candidates: number[] = [];
  for (const entry of [usage.five_hour, usage.seven_day]) {
    const raw = entry?.resets_at ?? entry?.reset_at;
    if (!raw) { continue; }
    const t = new Date(raw).getTime();
    if (Number.isFinite(t) && t > Date.now()) { candidates.push(t); }
  }
  if (candidates.length === 0) { return null; }
  return Math.min(...candidates);
}

async function fetchUsage(): Promise<UsageResult> {
  const state = readSharedState();
  const now = Date.now();

  // Gate 1: fresh data — but bypass once the cached reset_at has elapsed.
  if (state.data && now - state.fetchedAt < FRESH_TTL_MS && !isUsagePastReset(state.data)) {
    return { data: state.data };
  }

  // Gate 2: in back-off window
  if (state.nextAllowedAt > now) {
    if (state.data) { return { data: state.data }; }
    const secs = Math.ceil((state.nextAllowedAt - now) / 1000);
    return { data: null, error: `cooling down ${secs}s` };
  }

  // Gate 3: another instance holds the fetch lock
  if (state.lockPid && state.lockPid !== process.pid && now - state.lockAt < LOCK_TTL_MS) {
    return { data: state.data };
  }

  const token = getOAuthToken();
  if (!token) { return { data: state.data }; }

  // If this exact token already 401'd and no refresh has landed yet, skip.
  // Prevents hammering the API with a known-bad token while `claude update`
  // runs asynchronously in the background.
  if (lastFailedToken && token === lastFailedToken) {
    return { data: state.data, error: 'HTTP 401' };
  }

  writeSharedState({ ...state, lockPid: process.pid, lockAt: now });

  try {
    const res = await httpGetWithStatus('https://api.anthropic.com/api/oauth/usage', {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    });

    if (res.statusCode === 429) {
      // Prefer server-supplied Retry-After, clamped to a sane band.
      // Falls back to the previous 15-minute hard backoff when absent.
      const retryAfter = parseRetryAfter(res.headers);
      let backoffMs: number;
      if (retryAfter !== null) {
        backoffMs = Math.max(BACKOFF_RATE_LIMIT_MIN_MS, Math.min(BACKOFF_RATE_LIMIT_MAX_MS, retryAfter));
      } else {
        backoffMs = BACKOFF_RATE_LIMIT_MS;
      }
      writeSharedState({ ...state, nextAllowedAt: Date.now() + backoffMs, lockPid: 0, lockAt: 0 });
      return { data: state.data, error: 'HTTP 429' };
    }

    if (res.statusCode === 401) {
      // Kick off a token refresh in the background and guard against re-trying
      // with the same dead token until a new one lands on disk.
      lastFailedToken = token;
      writeSharedState({ ...state, nextAllowedAt: Date.now() + BACKOFF_AUTH_ERROR_MS, lockPid: 0, lockAt: 0 });
      tryRefreshToken();
      return { data: state.data, error: 'HTTP 401' };
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      writeSharedState({ ...state, nextAllowedAt: Date.now() + BACKOFF_ERROR_MS, lockPid: 0, lockAt: 0 });
      return { data: state.data, error: `HTTP ${res.statusCode}` };
    }

    const parsed = JSON.parse(res.body) as UsageData;
    if (!parsed.five_hour && !parsed.seven_day) {
      writeSharedState({ ...state, lockPid: 0, lockAt: 0 });
      return { data: state.data };
    }

    // Successful fetch with a fresh token — clear any stale 401 guard.
    lastFailedToken = null;

    writeSharedState({
      data: parsed,
      fetchedAt: Date.now(),
      nextAllowedAt: 0,
      lockPid: 0,
      lockAt: 0,
    });
    return { data: parsed };
  } catch (err) {
    writeSharedState({ ...state, nextAllowedAt: Date.now() + BACKOFF_ERROR_MS, lockPid: 0, lockAt: 0 });
    const errMsg = err instanceof Error ? err.message : String(err);
    return { data: state.data, error: errMsg };
  }
}

function parseRetryAfter(headers: Record<string, string | string[] | undefined>): number | null {
  const raw = headers['retry-after'];
  if (!raw) { return null; }
  const value = Array.isArray(raw) ? raw[0] : raw;
  // Per RFC 7231: either delay-seconds or an HTTP-date. Handle both.
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }
  const asDate = new Date(value).getTime();
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    if (delta > 0) { return delta; }
  }
  return null;
}

const EMPTY_STATE: SharedState = { data: null, fetchedAt: 0, nextAllowedAt: 0, lockPid: 0, lockAt: 0 };

function readSharedState(): SharedState {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8'));
    if (raw && (raw.five_hour || raw.seven_day) && typeof raw.fetchedAt !== 'number') {
      return { ...EMPTY_STATE, data: raw as UsageData, fetchedAt: Date.now() - FRESH_TTL_MS };
    }
    return {
      data: raw.data ?? null,
      fetchedAt: Number(raw.fetchedAt) || 0,
      nextAllowedAt: Number(raw.nextAllowedAt) || 0,
      lockPid: Number(raw.lockPid) || 0,
      lockAt: Number(raw.lockAt) || 0,
    };
  } catch { return { ...EMPTY_STATE }; }
}

function writeSharedState(state: SharedState) {
  try {
    const dir = path.dirname(USAGE_CACHE_PATH);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify(state, null, 2));
  } catch { /* write failed — next tick will retry */ }
}

function getOAuthToken(): string {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) { return envToken; }

  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (token) { return token; }
  } catch { /* no creds file */ }

  if (process.platform === 'win32') {
    try {
      const result = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `$c = Get-StoredCredential -Target 'Claude Code-credentials' -ErrorAction SilentlyContinue; if ($c) { [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($c.Password)) }`
      ], { timeout: 3000, encoding: 'utf8' });
      if (result.trim()) {
        const data = JSON.parse(result.trim());
        if (data?.claudeAiOauth?.accessToken) { return data.claudeAiOauth.accessToken; }
      }
    } catch { /* no credential */ }
  }

  if (process.platform === 'darwin') {
    try {
      const result = execFileSync('security', [
        'find-generic-password', '-s', 'Claude Code-credentials', '-w'
      ], { timeout: 3000, encoding: 'utf8' });
      if (result.trim()) {
        const data = JSON.parse(result.trim());
        if (data?.claudeAiOauth?.accessToken) { return data.claudeAiOauth.accessToken; }
      }
    } catch { /* no keychain entry */ }
  }

  return '';
}

// ── Token refresh ──

function tryRefreshToken() {
  // Fire `claude update` in the background. The next poll tick sees either
  // a changed token on disk (and retries) or the same dead token (and skips).
  if (tokenRefreshInFlight) { return; }
  tokenRefreshInFlight = true;

  const cliPath = findClaudeCli();
  if (!cliPath) {
    tokenRefreshInFlight = false;
    return;
  }

  execFile(cliPath, ['update'], { timeout: 60_000, windowsHide: true }, () => {
    // Outcome is irrelevant — success path: next read picks up the new token;
    // failure path: lastFailedToken guard keeps us from spamming requests.
    tokenRefreshInFlight = false;
  });
}

function findClaudeCli(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.cmd'));
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'));
    candidates.push('/usr/local/bin/claude');
    candidates.push('/opt/homebrew/bin/claude');
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) { return c; } } catch { /* not here */ }
  }
  return null;
}

// ── Time helpers ──

function fmtDuration(mins: number): string {
  const totalMins = Math.max(0, Math.floor(mins));
  const d = Math.floor(totalMins / (24 * 60));
  const h = Math.floor((totalMins % (24 * 60)) / 60);
  const m = totalMins % 60;
  if (d > 0) { return `${d}d ${String(h).padStart(2, '0')}h`; }
  if (h > 0) { return `${h}h ${String(m).padStart(2, '0')}m`; }
  return `${m}m`;
}

function fmtHour(h: number): string {
  h = ((h % 24) + 24) % 24;
  const hInt = Math.floor(h);
  const mInt = Math.round((h - hInt) * 60);
  return `${String(hInt).padStart(2, '0')}:${String(mInt).padStart(2, '0')}`;
}

function fmtResetTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMin = Math.floor((d.getTime() - Date.now()) / 60_000);
    if (diffMin <= 0) { return 'syncing'; }
    return `in ${fmtDuration(diffMin)}`;
  } catch { return iso; }
}

function fmtClockTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

// ── Timezone helpers ──

function getPacificOffset(): number {
  const now = new Date();
  const year = now.getUTCFullYear();
  const mar1 = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 1 + ((7 - mar1.getUTCDay()) % 7) + 7, 10));
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, 1 + ((7 - nov1.getUTCDay()) % 7), 9));
  return (now >= dstStart && now < dstEnd) ? -7 : -8;
}

function getSourceOffset(tz: string): number {
  if (!tz || tz === 'America/Los_Angeles') { return getPacificOffset(); }
  if (tz === 'UTC' || tz === 'Etc/UTC') { return 0; }
  const p = getPacificOffset();
  const offsets: Record<string, number> = {
    'America/New_York': p + 3, 'America/Chicago': p + 2, 'America/Denver': p + 1,
  };
  return offsets[tz] ?? getPacificOffset();
}

function peakHoursToLocal(schedule: Schedule, localOffset: number): { startLocal: number; endLocal: number } {
  const peak = schedule.peak;
  const srcOffset = getSourceOffset(peak.tz);
  return {
    startLocal: ((peak.start - srcOffset + localOffset) % 24 + 24) % 24,
    endLocal: ((peak.end - srcOffset + localOffset) % 24 + 24) % 24,
  };
}

function minsUntilNextPeak(now: Date, peakDays: number[], startLocalHour: number): number {
  const hour = now.getHours() + now.getMinutes() / 60;
  const weekday = now.getDay() === 0 ? 7 : now.getDay();
  for (let offset = 1; offset <= 7; offset++) {
    const nextDay = ((weekday - 1 + offset) % 7) + 1;
    if (peakDays.includes(nextDay)) {
      return Math.floor((24 - hour) * 60) + (offset - 1) * 1440 + Math.floor(startLocalHour * 60);
    }
  }
  return 0;
}

// ── HTTP helpers ──

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpGetWithStatus(
  url: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname,
      method: 'GET', timeout: 5000, headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        body: data,
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
