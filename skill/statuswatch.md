---
name: statuswatch
description: Budget-aware execution guard - monitors the Claude Code usage quota (via the Claude Code Statusline extension's cache) while heavy work runs, and stops the work BEFORE the 5-hour window is exhausted, so the user always keeps headroom to stop, steer, or work in parallel. Activate when the user green-lights heavy work (workflows, multi-agent fan-outs, long autonomous tasks) and asks to watch the quota - phrases like "statuswatch", {{TRIGGER_PHRASES}} or natural variations. Also for a plain status question ("how much quota is left?").
---

# statuswatch - Budget-Aware Execution (usage-cap guard during heavy work)

## Purpose

The 5-hour usage window is **account-wide** - shared across every Claude surface the user has (desktop, phone, other projects). One prompt that launches a fleet of agents on an expensive model can max the window and **lock the user out completely**: unable to stop or save the session, unable to work on anything else, not even a light model from their phone.

statuswatch exists so that no single task ever does that. While heavy work runs, sample the usage cache on a heartbeat and stop the work while the user still has usable headroom; resume on a fresh window. **Maximize window utilization - never choke it.**

## What this skill does / does not do

- ✅ READS one local file (the statusline extension's usage cache). Nothing else.
- ✅ Stops running work (TaskStop) and schedules its own check-ins (ScheduleWakeup).
- ❌ No network calls, no credential access, nothing leaves the machine.
- ❌ Never self-activates: runs only when the user asks (trigger phrases above).

## Hard dependency: the Claude Code Statusline extension

The extension is the ONLY usage sensor - the model has no built-in way to see account quota. **statusline = the sensor, statuswatch = the controller.** If the cache is missing or frozen, this skill cannot function: say so and stop; do NOT improvise another data source.

## The data source

`<os.tmpdir()>/claude/statusline-usage-cache.json` - e.g. `C:\Users\<user>\AppData\Local\Temp\claude\statusline-usage-cache.json` on Windows, `/tmp/claude/statusline-usage-cache.json` on Linux. Written by the extension; refreshes every ≈120s (±25% jitter), faster (60s bursts) while usage climbs, and every 30s right after a window reset. (Schema verified against extension v0.3.x.)

| Field | Meaning |
|---|---|
| `data.five_hour.utilization` | 5-hour window, percent (integer). The main throttle. |
| `data.five_hour.resets_at` | ISO timestamp (UTC) of the next 5h reset. |
| `data.seven_day.utilization` | Weekly all-models percent. |
| `data.limits[]` | Includes `kind:"weekly_scoped"` - a per-model weekly cap that can run HIGHER than `seven_day`. Guard on the **max of all `group:"weekly"` entries**. |
| `fetchedAt` | Epoch ms of last refresh. Older than ≈5 min = stale - re-read once before acting; still frozen = the sensor is down, tell the user. |

Read snippet:

```bash
node -e "const p=require('path').join(require('os').tmpdir(),'claude','statusline-usage-cache.json'); const c=require(p); const d=c.data; const w=Math.max(d.seven_day.utilization, ...(d.limits||[]).filter(l=>l.group==='weekly').map(l=>l.percent)); console.log('5h='+d.five_hour.utilization+'% (reset '+d.five_hour.resets_at+') | weekly(max)='+w+'% | age='+Math.round((Date.now()-c.fetchedAt)/1000)+'s')"
```

## Configuration (set at install; user can override per-run)

| Knob | Value | Meaning |
|---|---|---|
| **CAP** | **{{CAP}}%** | Max 5h utilization before work stops. The user's headroom = 100 − CAP. |
| STOP TRIGGER | CAP − 10 | The reading at which to actually TaskStop - one worst-case heartbeat of burn below CAP (see the math). |
| HEARTBEAT (hot) | 150s | Sampling interval while parallel high-effort agents run. |
| HEARTBEAT (cool) | 240-600s | Interval once only light/serial agents remain. |
| WEEKLY STOP | 85% | Secondary guard (max of all weekly entries) - stop everything, don't re-arm. |
| BACKSTOP | 12 shifts | Runaway guard, independent of quota - a hard wall-clock / shift ceiling so a benign loop that never trips CAP (e.g. lots of free local compute) can't run forever. For a bounded job the user names a tighter cap ("only 3 shifts", "until 08:00"). |

If the user names other numbers in the moment ("stop at 60"), those win for that run. **Only CAP / BACKSTOP are meant to move** - the HEARTBEAT and the CAP−10 trigger gap encode the measured burn-rate (see the math) and shouldn't be re-tuned casually; a wrong value silently breaks the headroom guarantee.

### The math behind the defaults

- **Worst-case landing ≈ STOP TRIGGER + (burn rate per minute × heartbeat in minutes).** A fleet of ≈9 parallel max-effort agents burns ≈4.5%/min at peak - so a 150s heartbeat can move ≈11% between samples. That is why the trigger sits 10 points under CAP, and why the two knobs are COUPLED: widen the heartbeat and you must lower the trigger accordingly.
- **Why 150s:** the sensor itself refreshes every ≈120s ±25% jitter (up to ≈150s). Sampling faster just re-reads the same cached value and burns quota on the wakeups themselves; sampling at 5+ minutes can miss a 20%+ jump. 150s is the sweet spot: every wakeup meets a fresh sample. (If the user changed the extension's `refreshInterval`, scale the heartbeat with it.)

## Execution - guard mode

1. Launch the heavy task; record its **task ID + runId** (Workflow returns both).
2. Arm `ScheduleWakeup(150, "<monitor prompt>")` - the prompt must be self-contained: cache path, thresholds, task ID, runId, log path, this decision tree.
3. Each firing - read the cache, branch, end turn:
   - **five_hour >= STOP TRIGGER** (primary) → TaskStop, log the runId, arm ONE wakeup for **`resets_at` + ≈2 min** (cap 3600s - longer than that, re-check on firing). The buffer exists because the sensor's cache can lag the reset by one poll cycle. On firing, **verify the reset in the DATA, not the clock**: `five_hour` must actually read low (< 30). Still high → short re-arm (60-90s), never launch blind. Verified fresh → resume: `Workflow({scriptPath, resumeFromRunId})`.
   - **weekly(max) >= WEEKLY STOP** → TaskStop, log, do NOT re-arm. Done until the user returns.
   - **Task finished** (artifact exists / task notification arrived) → stop monitoring, report.
   - **Task stalled / orphaned** (liveness - see below): not finished, but its progress artifact hasn't advanced for two consecutive firings → treat as dead. TaskStop, log, alert the user. Do NOT re-arm into a corpse.
   - **Backstop reached** (shift count or wall-clock cap) → TaskStop, log, alert the user with a brief. Runaway guard, independent of quota.
   - **Otherwise** → re-arm: 150s in a hot phase, 240-600s in a cool one.
4. Log one line per event (time UTC, 5h%, weekly%, action) to the task's log file.

### Liveness - guard the work, not just the quota

The quota heartbeat answers "how much have we burned," never "is the task still alive." A stalled or **orphaned** run - a background agent that died having written nothing, or a resume that never fired - keeps the monitor happily re-arming against a corpse: quota looks fine, so nothing trips, and the user later finds that zero work landed.

So on every firing, alongside the quota read, check a **progress signal** - the mtime (or size / last line) of the task's primary artifact or log. A cheap local stat, no quota cost:

- **Advanced since last firing** → alive; proceed with the normal branch.
- **Frozen for two consecutive firings** (the count 2 is a fixed constant, not a per-run knob) and the task isn't marked finished → stalled / orphaned. TaskStop, log, alert the user. Do NOT keep re-arming. A frozen artifact + healthy quota is the exact orphan signature.

(Idea adapted - inverted - from the `claude-code-nonstop` extension's output-growth detection: it watches growth to *ping and keep a session alive*; here a frozen signal means *stop and surface*, not nudge.)

### The shift pattern - tasks bigger than one 5h window

For a mission that doesn't fit one window, structure it as **shifts** - it can then run unattended to completion:

1. **Front-load the heavy work** into a fresh window (expensive parallel fan-out first, while the window is empty).
2. Work until the gate (STOP TRIGGER) → stop.
3. **Cooldown** until `resets_at` + buffer, verified in the data.
4. Next shift: resume or launch the next phase, keep guarding.
5. Repeat until done. Use **phase artifacts as the state machine** (presence of a file = phase done) so every shift is stateless and crash-proof.

Optional refinement: if a window burned hot (the gate fired mid-run), drop the next phase's agent effort one tier; if it ended cool, keep it.

This mode is opt-in per task - the user asks for it ("work in shifts until it's done"). Many tasks simply finish inside one window and never need it.

## Execution - status check (no heavy task)

Read the cache once, report, done. No wakeups. Format:

> **5h:** 46% (resets 17:29 UTC) | **weekly:** 20% | **weekly-scoped:** 31%

Show the scoped weekly only when it differs from the all-models number.

## ⛔ Hard rules

- **Exactly ONE wakeup armed per turn.** Double-armed loops multiply and burn the very quota they guard.
- **Monitor turns stay minimal.** Read cache, decide, act, end turn. No file re-reads, no analysis.
- **TaskStop is not failure.** Resume is cheap (`resumeFromRunId` replays completed agents from cache); stopping early always beats breaching the CAP. When in doubt, stop earlier.
- **Cache missing or `fetchedAt` frozen across two reads** → the sensor is down; tell the user instead of flying blind.
