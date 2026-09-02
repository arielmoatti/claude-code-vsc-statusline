#!/usr/bin/env node
/**
 * usage-poll.cjs - refresh the usage cache from OUTSIDE VSCode.
 *
 * WHY THIS EXISTS
 * ---------------
 * The statuswatch skill's only sensor is this extension, which runs inside
 * VSCode. In a headless Claude Code session (an SDK daemon, a bridge bot, a
 * cron/CI run, plain `claude` in a terminal with no editor open) nothing
 * refreshes `<tmp>/claude/statusline-usage-cache.json`, so the skill reads
 * hours-old numbers or gives up entirely.
 *
 * This script hits the SAME endpoint the extension hits, with the SAME token,
 * and writes the SAME cache file in the SAME shape. It is the same sensor
 * driven by a different clock - not a second source of truth.
 *
 * COST: local compute only. It spends no model tokens against the quota.
 *
 * USAGE
 *   node scripts/usage-poll.cjs            refresh, then print one summary line
 *   node scripts/usage-poll.cjs --read     print the cache as-is, no network
 *   node scripts/usage-poll.cjs --json     refresh, print the raw JSON
 *
 * EXIT CODES: 0 ok | 1 unexpected error | 2 no token | 3 HTTP error
 *
 * Requires Node 18+. No dependencies.
 */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_CACHE_PATH = path.join(os.tmpdir(), 'claude', 'statusline-usage-cache.json');

/** Same lookup order as the extension: env, creds file, OS keychain. */
function getOAuthToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;

  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const t = creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
    if (t) return t;
  } catch { /* no creds file */ }

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "$c = Get-StoredCredential -Target 'Claude Code-credentials' -ErrorAction SilentlyContinue; " +
        'if ($c) { [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(' +
        '[System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($c.Password)) }'
      ], { timeout: 5000, encoding: 'utf8' });
      if (out.trim()) {
        const d = JSON.parse(out.trim());
        if (d && d.claudeAiOauth && d.claudeAiOauth.accessToken) return d.claudeAiOauth.accessToken;
      }
    } catch { /* no stored credential */ }
  }

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5000, encoding: 'utf8' });
      if (out.trim()) {
        const d = JSON.parse(out.trim());
        if (d && d.claudeAiOauth && d.claudeAiOauth.accessToken) return d.claudeAiOauth.accessToken;
      }
    } catch { /* no keychain entry */ }
  }

  return '';
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8')); } catch { return null; }
}

// The extension's weekly burn-pace LED measures quota spent per hour of actual
// work, which it recovers from this sample history. Without an entry from here,
// every headless stretch (Telegram bridge, SDK daemon, cron) looks like idle
// time to that estimator and the pace reads far too calm. Same file, same
// format, same dedup key (fetchedAt) as the extension writes.
const HISTORY_PATH = path.join(os.tmpdir(), 'claude', 'statusline-usage-history.jsonl');

function recordHistory(state) {
  try {
    const w = state?.data?.seven_day?.utilization;
    if (!Number.isFinite(w)) { return; }
    const h = state?.data?.five_hour?.utilization;

    let lastT = null;
    try {
      const lines = fs.readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && lastT === null; i--) {
        try { const o = JSON.parse(lines[i]); if (Number.isFinite(o.t)) { lastT = o.t; } } catch { /* skip */ }
      }
    } catch { /* no history yet */ }
    if (lastT !== null && state.fetchedAt <= lastT) { return; }

    const round2 = n => Math.round(n * 100) / 100;
    const row = {
      t: Math.round(state.fetchedAt),
      w: round2(w),
      h: round2(Number.isFinite(h) ? h : 0),
    };
    // Which weekly window the reading belonged to. Without it a downward
    // revision of the weekly figure is indistinguishable from a real reset.
    const rawReset = state.data.seven_day.resets_at || state.data.seven_day.reset_at;
    const resetMs = rawReset ? new Date(rawReset).getTime() : NaN;
    if (Number.isFinite(resetMs)) { row.r = Math.round(resetMs); }
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n');
  } catch { /* history is best-effort */ }
}

/** One line in the shape statuswatch expects to reason over. */
function summarize(state) {
  if (!state || !state.data) return 'no usage data in cache';
  const d = state.data;
  const weekly = (d.limits || []).filter(l => l.group === 'weekly').map(l => l.percent);
  const weeklyMax = Math.max(d.seven_day.utilization, ...(weekly.length ? weekly : [0]));
  const ageS = Math.round((Date.now() - state.fetchedAt) / 1000);
  return `5h=${d.five_hour.utilization}% (reset ${d.five_hour.resets_at}) | weekly(max)=${weeklyMax}% | age=${ageS}s`;
}

function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

(async () => {
  const asJson = process.argv.includes('--json');

  if (process.argv.includes('--read')) {
    const c = readCache();
    console.log(asJson ? JSON.stringify(c, null, 2) : summarize(c));
    return;
  }

  const token = getOAuthToken();
  if (!token) {
    console.log('ERROR: no OAuth token found (checked CLAUDE_CODE_OAUTH_TOKEN, ~/.claude/.credentials.json, OS keychain)');
    process.exit(2);
  }

  const res = await fetchUsage(token);
  if (res.status !== 200) {
    // 401 = token expired (open Claude Code once to refresh it). 429 = backing off.
    console.log(`ERROR: HTTP ${res.status} - cache NOT updated. Last known: ${summarize(readCache())}`);
    process.exit(3);
  }

  const prev = readCache() || {};
  const state = {
    ...prev,
    data: JSON.parse(res.body),
    fetchedAt: Date.now(),
    // Clear the extension's coordination fields so a live VSCode instance
    // is never blocked by a lock this process didn't take.
    lockPid: 0,
    lockAt: 0,
    nextAllowedAt: 0,
  };

  fs.mkdirSync(path.dirname(USAGE_CACHE_PATH), { recursive: true });
  fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify(state, null, 2));
  recordHistory(state);

  console.log(asJson ? JSON.stringify(state.data, null, 2) : summarize(state));
})().catch(e => { console.log('ERROR: ' + e.message); process.exit(1); });
