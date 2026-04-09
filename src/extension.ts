import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import { execFileSync } from 'child_process';

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

interface UsageData {
  five_hour?: { utilization: number; reset_at?: string; resets_at?: string };
  seven_day?: { utilization: number; reset_at?: string; resets_at?: string };
}

// ── Constants ──

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CREDENTIALS_PATH = path.join(CLAUDE_DIR, '.credentials.json');
const SCHEDULE_CACHE_PATH = path.join(CLAUDE_DIR, 'statusline-schedule.json');
const USAGE_CACHE_PATH = path.join(os.tmpdir(), 'claude', 'statusline-usage-cache.json');

const SCHEDULE_URL = 'https://raw.githubusercontent.com/Nadav-Fux/claude-2x-statusline/main/schedule.json';

const DEFAULT_SCHEDULE: Schedule = {
  v: 2, mode: 'peak_hours',
  peak: {
    enabled: true, tz: 'America/Los_Angeles',
    days: [1, 2, 3, 4, 5], start: 5, end: 11,
    label_peak: 'Peak', label_offpeak: 'Off-Peak',
  },
};

// ── State ──

let peakItem: vscode.StatusBarItem;
let fhItem: vscode.StatusBarItem;
let wdItem: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let cachedSchedule: Schedule | null = null;
let cachedUsage: UsageData | null = null;
let usageFetchedAt = 0;

// ── Activation ──

export function activate(context: vscode.ExtensionContext) {
  peakItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 201);
  fhItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  wdItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 199);

  context.subscriptions.push(peakItem, fhItem, wdItem);
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeStatusline.refresh', () => refresh())
  );

  refresh();

  const intervalSec = vscode.workspace.getConfiguration('claudeStatusline').get<number>('refreshInterval', 30);
  refreshTimer = setInterval(() => refresh(), intervalSec * 1000);
}

export function deactivate() {
  if (refreshTimer) { clearInterval(refreshTimer); }
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
  // Check cache (6h)
  try {
    const stat = fs.statSync(SCHEDULE_CACHE_PATH);
    if ((Date.now() - stat.mtimeMs) / 3_600_000 < 6) {
      return JSON.parse(fs.readFileSync(SCHEDULE_CACHE_PATH, 'utf8'));
    }
  } catch { /* no cache */ }

  // Fetch remote
  try {
    const data = await httpGet(SCHEDULE_URL);
    const schedule = JSON.parse(data);
    fs.writeFileSync(SCHEDULE_CACHE_PATH, JSON.stringify(schedule, null, 2));
    return schedule;
  } catch { /* fetch failed */ }

  // Stale cache fallback
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
  if (!show) { fhItem.hide(); wdItem.hide(); return; }

  const usage = await fetchUsage();
  if (!usage) { fhItem.hide(); wdItem.hide(); return; }

  const fh = usage.five_hour;
  const wd = usage.seven_day;
  updateLimitItem(fhItem, '5h', Math.round(fh?.utilization ?? 0), fh?.resets_at ?? fh?.reset_at,
    '#3dc9b0', '#e8ab3a', '#f14c4c');
  const wdPct = Math.round(wd?.utilization ?? 0);
  if (wdPct >= 50) {
    updateLimitItem(wdItem, '7d', wdPct, wd?.resets_at ?? wd?.reset_at,
      '#b4a0ff', '#d4a0ff', '#f14c4c');
  } else {
    wdItem.hide();
  }
}

function updateLimitItem(item: vscode.StatusBarItem, label: string, pct: number,
  resetAt: string | undefined, colorLow: string, colorMid: string, colorHigh: string) {
  const bar = batteryBar(pct);
  const resetStr = resetAt ? ` \u27F3${fmtResetTime(resetAt).replace('in ', '')} (${fmtClockTime(resetAt)})` : '';
  const icon = pct >= 80 ? '$(warning) ' : '';

  item.text = `${icon}${label} | ${pct}% ${bar}${resetStr}`;
  item.color = pct >= 80 ? colorHigh : pct >= 50 ? colorMid : colorLow;
  item.backgroundColor = undefined;

  item.tooltip = '';
  item.show();
}

function batteryBar(pct: number): string {
  const width = 8;
  const filled = Math.round(pct * width / 100);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function usageBar(pct: number): string {
  const width = 15;
  const filled = Math.floor(pct * width / 100);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

// ── Usage fetch ──

async function fetchUsage(): Promise<UsageData | null> {
  if (cachedUsage && Date.now() - usageFetchedAt < 60_000) { return cachedUsage; }

  const token = getOAuthToken();
  if (!token) { return cachedUsage ?? loadUsageFromDisk(); }

  try {
    const data = await httpGetWithHeaders('https://api.anthropic.com/api/oauth/usage', {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    });
    const parsed = JSON.parse(data);
    if (!parsed.five_hour && !parsed.seven_day) { return cachedUsage ?? loadUsageFromDisk(); }
    cachedUsage = parsed;
    usageFetchedAt = Date.now();
    saveUsageToDisk(parsed);
    return cachedUsage;
  } catch {
    // Back off on error (e.g. 429) — don't retry for 5 minutes
    usageFetchedAt = Date.now() - 60_000 + 300_000;
    return cachedUsage ?? loadUsageFromDisk();
  }
}

function loadUsageFromDisk(): UsageData | null {
  try {
    const data = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8'));
    if (data.five_hour || data.seven_day) {
      cachedUsage = data;
      usageFetchedAt = Date.now() - 55_000;
      return data;
    }
  } catch { /* no disk cache */ }
  return null;
}

function saveUsageToDisk(data: UsageData) {
  try {
    const dir = path.dirname(USAGE_CACHE_PATH);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify(data, null, 2));
  } catch { /* write failed */ }
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

// ── Time helpers ──

function fmtDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
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
    if (diffMin <= 0) { return 'now'; }
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

function httpGetWithHeaders(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname,
      method: 'GET', timeout: 5000, headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) { resolve(data); }
        else { reject(new Error(`HTTP ${res.statusCode}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
