# Gateway: Programmatic Agent Execution

The polpo gateway turns the dashboard into a **remote intelligent worker** for external software. Any HTTP client with a valid API key can delegate one-shot agent tasks (Claude, Codex, Goose, Pi, Gemini, OpenCode) to the host running polpo, stream the output back as Server-Sent Events, and exchange files in both directions.

Typical use case: your laptop reaches a home PC over VPN, and an external orchestrator (openclaw, a Slack bot, a CI runner, a custom script) delegates concrete work (read this PDF, generate that document, refactor this file) to the agents installed on the PC.

> **Building an AI agent that calls this API?** See [gateway-for-ai-agents.md](gateway-for-ai-agents.md) — a compact, agent-oriented guide you can drop into a system prompt.

## Quick Start

```bash
# Hub + dashboard + gateway, on the same port
polpo server --gateway

# Or headless gateway-only (no phone UI, no tunnel)
polpo gateway
```

On first start polpo prints the API key once and persists it to `~/.config/polpo/gateway.json` (mode 0o600). All `/v1/*` requests must carry `Authorization: Bearer <that-key>`.

```bash
KEY=$(jq -r .key ~/.config/polpo/gateway.json)
curl -s -H "Authorization: Bearer $KEY" http://localhost:7890/v1/health
```

## How It Differs from the Dashboard

| Aspect | Dashboard (`/api/*`) | Gateway (`/v1/*`) |
|--------|----------------------|--------------------|
| Audience | Humans (phone, browser) | Machines (scripts, bots, agents) |
| Auth | Token + optional PIN/TOTP + session cookies | Long-lived Bearer key only |
| Stability | May change between releases | Stable API contract under `/v1` |
| Approvals | Phone-based | Fail closed (`approval_required`) |
| Sessions | Long-lived, multi-turn | One-shot tasks, no follow-ups |
| Visibility | Dashboard shows the conversation | Dashboard shows the gateway-spawned arm (`source: 'gateway:<client>'`), can be observed live |

Both surfaces share the same `InstanceManager`. A gateway-spawned arm registers normally so you can watch it from your phone while it works, abort it manually if needed, or even let the Alien Mind coordinate it.

## CLI Surface

```
polpo server --gateway       # dashboard + gateway, same port
polpo gateway                # alias for the above (forward-compat, may go headless later)
```

The `--gateway` flag is purely additive — every other flag (`--tunnel`, `--auth=paranoid`, `--trust-localhost`, etc.) works alongside it.

## Authentication

`/v1/*` always requires:

```
Authorization: Bearer <POLPO_GATEWAY_KEY>
```

The key is independent from the dashboard token (`POLPO_AUTH_TOKEN`). Two distinct controls, two distinct revocation surfaces.

Precedence for resolving the key on startup:

1. `--gateway-key <value>` flag (not yet exposed in CLI, but accepted by `createServer`)
2. `POLPO_GATEWAY_KEY` env var
3. `~/.config/polpo/gateway.json`
4. Auto-generated on first start, persisted to disk

The middleware uses constant-time comparison (`crypto.timingSafeEqual`) so failed-auth latency doesn't leak the prefix of the expected key.

### Rate Limiting

Per-bearer-token buckets (sha256-hashed) for the file-transfer routes:

| Route | Cap |
|-------|-----|
| `POST /v1/uploads` | 60/min per token |
| `GET /v1/tasks/:id/artifacts*` | 60/min per token |

Exceeded → `429 rate_limited` with `Retry-After` header. Buckets refill after the window.

Per-IP limits are deliberately not used: with a single shared key today, every caller appears as the same IP behind a VPN/tunnel, so IP buckets are useless. Hashing the bearer is forward-compatible with multi-key setups.

## API Reference

### `GET /v1/health`

```json
{ "status": "ok", "version": "1.2.0", "activeTasks": 0 }
```

### `POST /v1/tasks`

Create a one-shot task. The body:

```json
{
  "agentType":  "claude",
  "cwd":        "/abs/path/on/the/host",
  "prompt":     "the instruction for the agent",
  "timeoutMs":  300000,
  "client":     "remote-claude",
  "attachments":      [{ "uploadId": "u-..." }],
  "captureArtifacts": true
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `agentType` | yes | `claude` \| `codex` \| `gemini` \| `opencode` \| `pi` \| `goose` |
| `cwd` | yes | Absolute path that must exist on the host. Validated before the agent is spawned. |
| `prompt` | yes | ≤ 50 000 chars |
| `timeoutMs` | no | Default 5 min, hard-capped at `POLPO_GATEWAY_MAX_TIMEOUT_MS` (default 30 min) |
| `client` | no | Free-form label, also overrideable via `X-Polpo-Client` header. Becomes `source: 'gateway:<client>'` on the spawned instance and shows up in the dashboard. |
| `attachments` | no | Up to 20 entries. Each must reference an `uploadId` created earlier by the same caller. |
| `captureArtifacts` | no | When `true`, polpo creates a sealed dir and prepends a `<polpo:artifacts>` directive to the prompt (see [Artifacts](#artifacts)). |

Response `201`:

```json
{
  "taskId":    "gtask-deadbeef",
  "streamUrl": "/v1/tasks/gtask-deadbeef/stream"
}
```

Common error responses:

| Status | Body `error` | Cause |
|--------|--------------|-------|
| 400 | `invalid_agentType` | Not in the accepted set |
| 400 | `invalid_cwd` \| `cwd_must_be_absolute` \| `cwd_does_not_exist` \| `cwd_not_a_directory` | Bad cwd. `detail` field contains the offending path. |
| 400 | `invalid_prompt` \| `prompt_too_long` | Empty or > 50 KB |
| 400 | `invalid_attachments` \| `duplicate_attachment` \| `too_many_attachments` | `attachments` shape problems |
| 400 | `invalid_upload_id` | An `uploadId` doesn't match the UUID-v4 prefix |
| 403 | `upload_forbidden` | The upload was created by a different bearer token |
| 404 | `upload_not_found` | The `uploadId` doesn't exist (or expired and was cleaned up) |
| 410 | `upload_expired` | Past 1-hour TTL |
| 429 | `max_concurrent_reached` | Default 4 concurrent tasks. `limit` and `activeCount` in body. |
| 503 | `agent_ws_timeout` \| `agent_send_failed` | Agent didn't come online in 5 s |

### `GET /v1/tasks/:id/stream` (SSE)

Returns a Server-Sent Events stream. Event types, in order of emission:

```
event: chunk        data: { "text": "..." }              ← assistant output (zero or more)
event: approval     data: { "request": {...} }           ← always followed by error
event: artifacts    data: [{name,size,mediaType}, ...]   ← only if captureArtifacts: true
event: done         data: { "result":{...}, "output":"...", "durationMs":N, "artifacts":[...] }
event: error        data: { "message": "..." }
```

Comment lines like `: ping` arrive every 15 s to keep proxies from killing the connection — ignore them. The stream closes after `done` or `error`.

A subscriber that joins **after** a task has terminated receives the terminal state replayed once (a `done` or `error`), then the stream closes.

### `GET /v1/tasks/:id`

Snapshot of the task state. Safe to poll instead of streaming.

```json
{
  "id":              "gtask-...",
  "client":          "remote-claude",
  "agentType":       "claude",
  "cwd":             "/...",
  "prompt":          "...",
  "status":          "starting" | "running" | "completed" | "failed" | "cancelled",
  "output":          "accumulated assistant text",
  "result":          { "success": true, "summary": "trailing 2 KB of output" } | null,
  "error":           "timeout" | "approval_required" | ... | null,
  "startedAt":       1700000000000,
  "completedAt":     1700000045000,
  "agentInstanceId": "fake-abc1",
  "durationMs":      45000
}
```

### `DELETE /v1/tasks/:id`

Aborts the agent and marks the task `cancelled`. Idempotent: `204` on success, `409 task_already_terminal` if already finished, `404` if unknown.

### `POST /v1/uploads`

Caller → host file push.

Body (JSON):

```json
{
  "filename":   "report.pdf",
  "mediaType":  "application/pdf",
  "dataBase64": "<base64>"
}
```

Constraints:

- Filename pattern `[A-Za-z0-9._-]`, max 100 chars
- `..`, `/`, `\`, NUL, control chars rejected outright
- Decoded size ≤ `POLPO_GATEWAY_MAX_UPLOAD_SIZE` (default 25 MB)
- JSON body ≤ 34 MB (base64 + JSON-escape overhead)

Response `201`:

```json
{
  "uploadId":  "u-2235e914-e9d3-4d1d-84e5-38075f6cad9f",
  "filename":  "report.pdf",
  "mediaType": "application/pdf",
  "size":      543,
  "sha256":    "e4e86c9c...",
  "expiresAt": 1700003600000
}
```

Lifetime: **1 hour**. Periodic GC reclaims expired uploads. A task that references an upload pins it for the duration of the task, so an upload won't disappear out from under a running task.

Errors:

| Status | `error` | Cause |
|--------|---------|-------|
| 400 | `invalid_filename` | Path traversal, separators, NUL, control chars |
| 400 | `invalid_body` | Missing or non-string `dataBase64`, decoded to 0 bytes |
| 413 | `upload_too_large` | `limit`/`actual` in body |
| 429 | `rate_limited` | 60/min per token |
| 503 | `uploads_not_supported` | Gateway running without an upload store (shouldn't happen) |

### `GET /v1/tasks/:id/artifacts`

After a task with `captureArtifacts: true` finishes, list its sealed output files.

```json
{ "artifacts": [{ "name": "summary.md", "size": 778, "mediaType": "text/markdown; charset=utf-8" }] }
```

### `GET /v1/tasks/:id/artifacts/:name`

Stream a single sealed artifact.

Response headers (always):

- `X-Content-Type-Options: nosniff`
- `Content-Disposition: attachment; filename="<name>"` for non-image types,
   `inline; filename="<name>"` for whitelisted images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`)
- `Content-Type` is `application/octet-stream` for non-image types

Errors:

| Status | `error` | Cause |
|--------|---------|-------|
| 400 | `invalid_artifact_name` | Name fails `[A-Za-z0-9._-]{1,200}`, or traversal attempt |
| 403 | `task_forbidden` | Artifact belongs to a task created by a different bearer token |
| 404 | `task_not_found` \| `artifact_not_found` | |
| 409 | `task_not_terminal` | Task still running |

## Artifacts

When the caller sets `captureArtifacts: true`, polpo:

1. Creates `<tmpdir>/polpo-gateway-artifacts/<taskId>/write/` (mode 0o700)
2. Prepends a `<polpo:artifacts>` directive to the prompt:

   ```
   <polpo:artifacts dir="/tmp/polpo-gateway-artifacts/gtask-.../write" max-files="100" max-bytes="100000000">
   You are running inside polpo's gateway. If you produce output files
   for the caller, save them into the directory above.
   Only regular files written directly into that directory will be
   returned. Symlinks, subdirectories, and oversized files are ignored.
   Filenames must match [A-Za-z0-9._-] and be at most 200 chars.
   </polpo:artifacts>
   ```

3. On task finalize, the agent has terminated, so the write dir is quiescent. Polpo then **seals** the artifacts:
   - `lstat` each entry — refuse symlinks, sockets, devices, subdirs
   - Enforce per-file size cap (default 25 MB), aggregate cap (100 MB), file count cap (100)
   - Hard-link each surviving file into a sibling `sealed/` dir, then `chmod 0o400`
4. The download endpoint serves only from `sealed/`. Any later mutation in `write/` is invisible.

This split (`write/` open during the run, `sealed/` immutable after) defeats TOCTOU attacks where the agent (or anything else with write access) could swap a real file for a symlink between when polpo lists the artifacts and when the caller downloads one.

Artifacts are removed when the task's TTL fires (default 5 min after `done`).

## Session Discovery

A chatbot or other orchestrator usually wants to **route a query to the right session**, not just execute a fresh task. The gateway exposes four read-only endpoints for that: search across past and live conversations, list the catalogue, and read a single session's history.

All four require the same Bearer key as the rest of `/v1/*`. Per-token rate limits apply: 30/min for the search endpoints, 60/min for the catalogue. Search returns hits from both on-disk past sessions and live in-memory conversations on the host.

> **Trust note**: the gateway key is a master key for these endpoints today. Any holder can search every session on the host. Future multi-key support will scope results by token ownership; the response shape is already forward-compatible (each result carries its origin).

### `GET /v1/search`

Low-level: per-message hits, sorted newest-first. Mirrors the existing dashboard `/api/search` shape, plus an `include` filter and a `source` field on each hit.

```
?q=<2..200 chars>&limit=<1..100, default 20>&include=<disk|memory|all, default all>
→ {
    results: [{
      sessionId, role, snippet, matchIndex, matchLength, timestamp,
      source: "disk" | "memory",
      instanceId?         // present only when source === "memory"
    }],
    partial: boolean
  }
```

Errors: 400 `invalid_query` (length out of bounds), 400 `invalid_include`, 429 `rate_limited`, 429 `search_in_progress` (another scan is already running on the host).

### `GET /v1/sessions/search`

High-level: results grouped per session, ranked for routing. Use this when you don't care about individual matches — you want to pick the right session out of many.

```
?q=<2..200 chars>&limit=<1..50, default 10>&snippets=<0..5, default 3>
→ {
    sessions: [{
      sessionId,
      instanceId,           // null unless this session is currently live
      project, cwd, agentType,
      firstPrompt,          // truncated to 200 chars
      lastActivity,         // epoch ms; live instance's value when available
      matchCount,
      score,                // higher is more relevant
      topSnippets: [{ snippet, role, timestamp, matchIndex, matchLength }]
    }],
    partial: boolean
  }
```

Ranking: `score = matchCount + recencyBoost`, where the boost adds up to 5 points for a match today and decays linearly to 0 at 30 days old. A session with 5 matches today (score ≈ 10) outranks one with 5 matches a year ago (score = 5). Sessions tie-break on `lastActivity` desc.

### `GET /v1/sessions`

Catalogue of every session on the host, live and past, sorted by `lastActivity` desc.

```
?source=<claude|codex|gemini|opencode|pi|goose|gateway|mind|all, default all>
&days=<1..365, default 30>
&limit=<1..200, default 50>
→ {
    sessions: [{
      sessionId,
      instanceId,           // present when the session is live
      project, cwd, agentType,
      firstPrompt,          // truncated to 200 chars
      lastActivity,
      isLive: boolean,
      source: "gateway:<client>" | "mind:<goalId-tail>" | null
    }]
  }
```

`source=gateway` filters to instances spawned via `POST /v1/tasks` (tagged `source: "gateway:<client>"`). `source=mind` filters to arms spawned by the Alien Mind coordinator (tagged `source: "mind:<goalId-tail>"`). Both `gateway` and `mind` tags only exist on **live** instances — the tags are not persisted to the on-disk transcript — so those two filters return live results only. The other `source=*` values filter by agent type and include both live and past sessions.

Errors: 400 `invalid_source`, 429 `rate_limited`.

### `GET /v1/sessions/:id`

Read one session's history. The id is validated against `^[A-Za-z0-9._-]{1,200}$` before any filesystem access; traversal attempts (`..`, `/`, NUL, control chars) return 400 immediately.

If a live instance matches the id, its in-memory conversation is returned. Otherwise polpo falls back to the on-disk transcript via `loadHistory(id)`.

```
?tail=<1..500>             # default: last 100 messages
or ?offset=<int>&limit=<1..500>
→ {
    messages: [{ role, content, timestamp, type?, contentType?, toolUseId? }],
    total,
    hasMore,
    isLive: boolean,
    instanceId: string | null
  }
```

Errors: 400 `invalid_session_id` (regex), 404 `session_not_found` (neither live nor on disk).

### Chatbot routing example

Imagine a Telegram bot fronting your laptop, asked "what's the current status of the auth-refactor feature?" The bot fans out to N polpo nodes over VPN, asks each "which session?", picks the highest-scoring match, then pulls or resumes context:

```bash
KEY=$POLPO_GATEWAY_KEY

# 1. Find candidate sessions across every reachable polpo node
for HOST in pc-laptop.vpn pc-desktop.vpn pc-homeserver.vpn; do
  curl -sf -H "Authorization: Bearer $KEY" \
    "https://$HOST:7890/v1/sessions/search?q=auth+refactor&limit=3" \
    | jq --arg host "$HOST" '.sessions[] | . + {host: $host}'
done | jq -s 'sort_by(-.score) | .[0]' > best.json

HOST=$(jq -r .host best.json)
SID=$(jq -r .sessionId best.json)

# 2. Pull the last 50 messages from the winning session for context
curl -sf -H "Authorization: Bearer $KEY" \
  "https://$HOST:7890/v1/sessions/$SID?tail=50" > history.json

# 3. Now either:
#    (a) summarise locally and reply to the user, or
#    (b) POST /v1/tasks on that host with the relevant cwd to spin up
#        a fresh one-shot agent that has the context (resumeable
#        sessions live in the dashboard surface, not /v1).
```

## Alien Mind Goals (`/v1/goals`) — experimental

> ⚠️ **Experimental.** The Alien Mind is still stabilising (see [docs/alien-mind.md](alien-mind.md)). Exposing its goal lifecycle over `/v1/goals` is a v1.2.1 addition with the same caveats: planning quality varies, fan-out can spawn multiple arms concurrently, and the SSE event surface may grow new event types in patch releases. Treat the API as stable for the listed event types only.

When the host has `POLPO_MIND=1` set, external software can submit *goals* — high-level instructions that the mind decomposes into a DAG of tasks and fans out across one or more arms. The mind brokers context between dependent arms (so task B sees task A's output), re-plans on failure (retry / split / abandon), and reports per-task progress over SSE.

If `POLPO_MIND=1` is **not** set, every `/v1/goals` route returns `503 mind_not_enabled`. The rest of `/v1/*` is unaffected.

### `POST /v1/goals`

```
POST /v1/goals
Authorization: Bearer $POLPO_GATEWAY_KEY
{
  "goal": "Refactor the auth module and update the tests",
  "client": "openclaw"
}

→ 201 {
    "goalId": "goal-deadbeef",
    "streamUrl": "/v1/goals/goal-deadbeef/stream"
  }
```

Rate limit: **10 per minute per token** (goals fan out across N arms — much heavier than one-shot tasks).

Errors: 400 `invalid_goal` (empty or > 50 000 chars), 400 `invalid_client` (non-string), 429 `rate_limited`, 503 `mind_not_enabled`.

### `GET /v1/goals/:id/stream` (SSE)

Streams the mind's progress for the goal. Events appear in roughly this order; some may repeat, some may be skipped depending on the plan:

```
event: snapshot      data: { goalId, status, prompt, plan, replayed: true }  ← only for late subscribers
event: planning      data: { goalId, prompt, timestamp }
event: plan_ready    data: { goalId, tasks: [{id, description, agentType, dependsOn}], timestamp }
event: task_started  data: { goalId, taskId, description, agentInstanceId, agentName, agentType }
event: task_chunk    data: { goalId, taskId, text }                          ← assistant output, possibly many
event: task_done     data: { goalId, taskId, success, summary, durationMs }
event: task_failed   data: { goalId, taskId, reason, terminal?, abandoned? }
event: replanning    data: { goalId, taskId, attempt, maxAttempts, reason }
event: cancelled     data: { goalId, reason }                                 ← from DELETE
event: done          data: { goalId, status, result, taskSummaries, durationMs }
event: error         data: { goalId, message, detail }
```

The stream closes after `done`, `cancelled`, or `error`. `: ping` comment lines arrive every 15 s.

**Late-subscriber handling.** Because the gateway emits a per-goal event stream as a live broadcast, a subscriber that connects *after* `planning` / `plan_ready` already fired would otherwise miss them. The gateway sends a synthetic `snapshot` event on connect for any goal in `running` state, containing the current plan and per-task status. Use this to bootstrap the UI; subsequent live events follow. Already-terminal goals receive a `done`/`error` replay and the stream closes immediately.

### `GET /v1/goals`

List the currently-active goals on this host.

```
→ {
    "goals": [{
      "id":         "goal-...",
      "status":     "planning" | "running" | "completed" | "failed",
      "prompt":     "...",            // truncated to 500 chars
      "result":     "..." | null,
      "createdAt":  1700000000000,
      "plan": {
        "tasks": [{
          "id", "description", "agentType", "status",
          "dependsOn", "startedAt", "completedAt", "durationMs", "summary"
        }]
      }
    }]
  }
```

### `GET /v1/goals/:id`

Same shape as one entry from `GET /v1/goals`. Returns `404 goal_not_found` for unknown ids, `400 invalid_goal_id` for ids that don't match `^goal-[a-z0-9-]{4,32}$`.

### `DELETE /v1/goals/:id`

Cancels the goal: aborts every running arm, marks every pending task failed, closes any open SSE streams with a `cancelled` event.

```
→ 204               (cancelled)
  | 409 goal_already_terminal { status }
  | 404 goal_not_found
  | 400 invalid_goal_id
```

### Chatbot example: delegate a goal across arms

```bash
KEY=$POLPO_GATEWAY_KEY
HOST=http://my-pc:7890

CREATE=$(curl -s -X POST $HOST/v1/goals \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "X-Polpo-Client: openclaw" \
  -d '{"goal":"Refactor the auth module: identify all callers, propose a new API, update them, then run the tests."}')

GOAL_ID=$(echo "$CREATE" | jq -r .goalId)

# Stream the mind's progress live
curl -N -H "Authorization: Bearer $KEY" $HOST/v1/goals/$GOAL_ID/stream
```

You'll see the mind plan the work, dispatch it to arms (some in parallel), broker context between dependent tasks, and finally emit `done` when every task is in a terminal state.

## Builder Profile (`/v1/profile`)

Returns a "how this host's operator works with AI agents" report. Computed entirely from local session transcripts — no LLM calls, no transcript content leaves the machine. Useful for an external bot that wants to introspect a host before deciding how to phrase a task ("the operator is heavy on tests and commits, I can be terse" vs. "the operator is heavy on plans, I should structure my request").

```
GET /v1/profile?days=<1..365, default 90>
&agent=<all|claude|codex|gemini|opencode|pi|goose, default all>

→ 200 {
    archetype: { key, name, blurb, dimension },
    dimensions: { steering, execution, engineering, productInstinct, planning },  // each 0..100
    activity: { totalSessions, analyzedSessions, activeDays, spanDays,
                sessionsPerActiveDay, firstActivity, lastActivity,
                peakHour, peakDay, hourHistogram, dowHistogram },
    agents:   [{ name, count }],
    models:   [{ name, count }],
    projects: [{ name, count }],
    prompts:  { count, avgWords, medianWords, longestWords,
                questionRatio, codeRatio, politeRatio, productRatio },
    tools:    { total, byCategory, top },
    shell:    { total, byCategory, gitCommits, testRuns },
    messages: { assistant, userPrompts },
    generatedAt
  }
```

Rate limit: **6/min per token** (the scan touches every session file on disk). Single in-flight call per host: concurrent requests return `429 profile_in_progress`. Server-side cache: 60 s per `(days, agent)` key.

Errors: 400 `invalid_source`, 429 `rate_limited`, 429 `profile_in_progress`, 500 `profile_failed`.

The full reference for the response shape, scoring heuristics, and privacy model lives in [docs/profile.md](profile.md).

## Security Model

- **Filesystem isolation**: uploads live under `<tmpdir>/polpo-gateway-uploads/<uploadId>/`, dirs 0o700, data files 0o600. Artifacts live under `<tmpdir>/polpo-gateway-artifacts/<taskId>/` with `sealed/` files 0o400.
- **Trust boundary preserved**: gateway uploads are **copied** into `UPLOAD_DIR` (the dir `WrappedAgent` already trusts) with a task-scoped name. `WrappedAgent`'s "only paths under `UPLOAD_DIR` are valid" check is unchanged.
- **Ownership scoping**: every upload records the sha256 of the bearer token that created it. Task-create and artifact-download routes re-check the fingerprint, so a future second key cannot read another caller's uploads or artifacts.
- **Path traversal**: filename regex + `..`/separator/NUL pre-rejection + `path.resolve` prefix check at every fs touchpoint. `lstat` (not `stat`) used for symlink defense.
- **Content sniffing**: `nosniff` + `attachment` on downloads. Inline allowed only for the same image whitelist the dashboard uses. SVG and HTML always force-attach (they can carry script).
- **Approval handling**: gateway tasks have no human in the loop, so any approval request from the agent fails the task immediately with `approval_required`. Callers must write self-sufficient prompts (e.g. set up permissions on the host beforehand).
- **No filenames in logs**: caller-controlled strings stay out of logs; uploads are recorded by size and sha256 for forensics.
- **No new dependencies**: pure Node 22, no multipart parsers, no third-party crypto.

## Configuration

| Env var | Default | Effect |
|---------|---------|--------|
| `POLPO_GATEWAY_KEY` | persisted to `~/.config/polpo/gateway.json` | Override the API key |
| `POLPO_GATEWAY_MAX_CONCURRENT` | 4 | Concurrent in-flight tasks |
| `POLPO_GATEWAY_MAX_TIMEOUT_MS` | 30 × 60 × 1000 | Hard cap on per-task `timeoutMs` |
| `POLPO_GATEWAY_MAX_UPLOAD_SIZE` | 25 × 1024 × 1024 | Per-upload byte cap (decoded) |

## File Layout (server-side)

```
src/agent/
  one-shot-runner.js    # Shared spawn → prompt → terminate primitive. ALSO consumed
                        #   by the Alien Mind, so the spawn/timeout/teardown logic is
                        #   identical between external HTTP callers and internal mind
                        #   orchestration. Owns: WS handshake, per-run timeout,
                        #   instance-manager event routing, approval fail-closed,
                        #   agent stop + unregister.

src/server/
  upload-constants.js   # shared UPLOAD_DIR, byte caps, regexes, sanitize helpers
  gateway-auth.js       # Bearer middleware, tokenFingerprint, per-token rate limit
  gateway-uploads.js    # GatewayUploadStore: put/get/pin/release/gcExpired
  gateway-artifacts.js  # GatewayArtifactStore: createDir/sealOnFinalize/openSealed/destroyTask
  gateway-tasks.js      # GatewayTaskManager: task records + SSE fanout + attachments
                        #   + artifacts. Delegates spawn-and-lifecycle to OneShotAgentRunner.
  gateway.js            # Express router mounted at /v1
```

### Why the runner is shared

The HTTP gateway and the Alien Mind have the same atomic operation underneath: "spawn an agent, give it one prompt, capture the result, terminate". The shared runner means:

- Bug fixes to spawn timing, approval handling, or teardown ordering land in one place and apply to both call sites.
- A mind-spawned arm shows up in the dashboard with the same kind of source-tag visibility (`source: 'mind:<goalId-tail>'`) that gateway-spawned arms get (`source: 'gateway:<client>'`).
- The session-discovery endpoints documented in the "Session discovery" section above accept `source=mind` alongside `source=gateway` for filtering.

External callers don't need to care about the runner directly — it's a private implementation detail. But if you're reading the codebase or debugging spawn issues, that's where the lifecycle lives.

## Worked Example

A remote caller pushes a markdown spec, asks the host agent to read it and produce a summary file, then pulls the summary back.

```bash
KEY=$POLPO_GATEWAY_KEY
HOST=http://my-pc:7890

# 1. Upload
DATA=$(base64 -w0 ./spec.md)
UP=$(curl -s -X POST $HOST/v1/uploads \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"spec.md\",\"mediaType\":\"text/markdown\",\"dataBase64\":\"$DATA\"}")
UID=$(echo "$UP" | jq -r .uploadId)

# 2. Create capturing task
T=$(curl -s -X POST $HOST/v1/tasks \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "X-Polpo-Client: my-orchestrator" \
  -d "{
    \"agentType\":\"claude\",
    \"cwd\":\"/home/user\",
    \"prompt\":\"Read the attached spec and write a one-paragraph summary to summary.md in the artifacts dir.\",
    \"attachments\":[{\"uploadId\":\"$UID\"}],
    \"captureArtifacts\":true,
    \"timeoutMs\":120000
  }")
TID=$(echo "$T" | jq -r .taskId)

# 3. Stream
curl -N -H "Authorization: Bearer $KEY" $HOST/v1/tasks/$TID/stream

# 4. Pull artifact
curl -s -OJ -H "Authorization: Bearer $KEY" $HOST/v1/tasks/$TID/artifacts/summary.md
cat summary.md
```

The same flow works from any HTTP client: Python `requests`, a curl in a CI job, a Tauri desktop app, an AI agent calling fetch().
