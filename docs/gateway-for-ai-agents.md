# Polpo Gateway — Instructions for an AI Agent

> Drop this file (or its content) into the system prompt of an AI agent that needs to drive a polpo node over HTTP. It's written for **you**, the agent: imperative, contract-first, with the constraints you must obey.

You can use polpo to:

1. **Execute work on a remote machine** — spawn a one-shot agent (Claude, Codex, Goose, Pi, Gemini, OpenCode), give it a prompt and optional input files, stream its output back, and pull any output files it produced.
2. **Discover prior work on that machine** — search the catalogue of past and live sessions, rank them, and read their history.

Both surfaces live under `/v1/*` and share one bearer key.

---

## 1. Identity & Auth

> ⚠️ **Every endpoint listed in this document requires authentication.** There are no public, anonymous, or read-only-bypass routes under `/v1/*`. If you don't send the bearer header, you get a 401 immediately, regardless of which path you hit.

Every request to `/v1/*` MUST include:

```
Authorization: Bearer <POLPO_GATEWAY_KEY>
```

If you don't have a key, ask the human operator for one. The key is **long-lived** and **distinct** from the dashboard token. **Do not log the key, store it in transcripts, or echo it back to the user.**

Optional but recommended on every request that mutates state:

```
X-Polpo-Client: <your-identifier>
```

This tag shows up in the operator's dashboard so they can see which agents (yours) are working remotely. Pick a stable, short, ASCII-only identifier (e.g. `openclaw`, `slack-bot`, `ci-runner`).

Failure modes you must handle:
- `401 unauthorized` — key missing or wrong; surface a clean error to the user, don't retry
- `429 rate_limited` — back off using the `Retry-After` header
- `429 search_in_progress` — another search is already running on this host; wait ~1 s and retry
- `503 *_not_supported` — the feature isn't enabled on this host; pick a different path

---

## 2. Endpoint catalogue (decide which to call)

🔒 **Every row below requires `Authorization: Bearer <POLPO_GATEWAY_KEY>` on the HTTP request.** Without it the response is `401 unauthorized` on every endpoint.

| You want to... | Call |
|---|---|
| Check if a polpo host is reachable | `GET /v1/health` |
| Run a one-shot agent task | `POST /v1/tasks` → SSE on `/v1/tasks/:id/stream` |
| Push a file the remote agent should read | `POST /v1/uploads` → reference its `uploadId` in `POST /v1/tasks` |
| Pull files the remote agent produced | `GET /v1/tasks/:id/artifacts[/:name]` after the task finishes |
| Find which session(s) on this host discussed topic X | `GET /v1/sessions/search?q=...` |
| Find individual message hits (low-level) | `GET /v1/search?q=...` |
| List every session on this host | `GET /v1/sessions` |
| Read one session's history | `GET /v1/sessions/:id` |
| Abort a runaway task you started | `DELETE /v1/tasks/:id` |
| Delegate a multi-step *goal* (mind plans + fans out across arms) | `POST /v1/goals` → SSE on `/v1/goals/:id/stream` *(experimental, host must have `POLPO_MIND=1`)* |
| List active goals / inspect / cancel | `GET /v1/goals`, `GET /v1/goals/:id`, `DELETE /v1/goals/:id` |
| Get the operator's working-style profile (statistics only, no transcripts) | `GET /v1/profile` |

### Decision rule: discover before executing

When the user's question implies they care about ongoing or past work ("status of feature X", "what did we decide about Y", "summarise the auth refactor"), **discover before executing**:

1. Call `/v1/sessions/search?q=<keywords>` on each known polpo host
2. Pick the highest-`score` session across all nodes
3. Call `/v1/sessions/:id?tail=50` on that host to load context
4. Either summarise from context alone, or spawn a task with that context if action is needed

If the user wants fresh work done (no prior context implied), skip discovery and go straight to `POST /v1/tasks`.

---

## 3. `GET /v1/health` — handshake

🔒 **Auth: Bearer required.** No anonymous probing.

Use this once at the start of a session to verify the host is reachable and to learn its version.

```json
{ "status": "ok", "version": "1.2.1", "activeTasks": 3 }
```

`activeTasks` tells you how many gateway-spawned agents are currently running. If it's near the host's `maxConcurrent` (default 4), expect `POST /v1/tasks` to return `429 max_concurrent_reached`.

---

## 4. `POST /v1/tasks` — execute work

🔒 **Auth: Bearer required.**

Request body:

```json
{
  "agentType":  "claude",
  "cwd":        "/absolute/path/on/the/REMOTE/host",
  "prompt":     "the instruction for the agent",
  "timeoutMs":  300000,
  "client":     "your-label",
  "model":      "claude-opus-4-7",
  "attachments":      [{ "uploadId": "u-..." }],
  "captureArtifacts": true
}
```

| Field | Required | Notes |
|---|---|---|
| `agentType` | yes | `claude` \| `codex` \| `gemini` \| `opencode` \| `pi` \| `goose` |
| `cwd` | yes | Absolute path that **must exist on the host**. Don't invent paths — discover them via `/v1/sessions`. |
| `prompt` | yes | ≤ 50 000 chars. Be specific and self-sufficient — see Section 8. |
| `timeoutMs` | no | Default 5 min, max 30 min. |
| `client` | no | Free label; also overrideable via `X-Polpo-Client` header. |
| `model` | no | Opaque string passed to the agent. Format is agent-specific (see below). Omit to use the host's CLI default. |
| `attachments` | no | ≤ 20 entries, each referencing an `uploadId` you created earlier. |
| `captureArtifacts` | no | `true` to receive files back. |

**`model` per agent type:**

| `agentType` | Format | Examples |
|---|---|---|
| `claude` | model id | `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| `codex` | model id | `gpt-5`, `o4-mini` |
| `gemini` | model id | `gemini-2.5-pro`, `gemini-2.5-flash` |
| `opencode` | `provider/model` | `anthropic/claude-sonnet-4-6`, `openai/gpt-5` |
| `pi` | model id | (single model today) |
| `goose` | `provider/model` | `ollama/qwen2.5`, `anthropic/claude-haiku-4-5`, `bedrock/anthropic.claude-3-5-sonnet`, `openai/gpt-5` |

The gateway does not validate the model against the agent's catalogue. If the agent rejects the model id, the task fails with the agent's error.

On success: `201 { taskId, streamUrl }`.

On error, the body has an `error` code. Common ones:

| Status | Code | Action |
|---|---|---|
| 400 | `invalid_agentType` | Use one from the list above |
| 400 | `invalid_model` | `model` is empty, > 200 chars, or contains control characters. Pass a clean string in the agent-specific format. |
| 400 | `cwd_does_not_exist` | The path doesn't exist on the host. Discover paths via `/v1/sessions` instead of guessing. |
| 400 | `prompt_too_long` | Trim or split the work into multiple tasks |
| 403 | `upload_forbidden` | Your `uploadId` belongs to a different bearer key |
| 404 | `upload_not_found` | The upload expired (1 h TTL) or never existed |
| 429 | `max_concurrent_reached` | Wait until `activeTasks` drops |

### Streaming the result

🔒 **Auth: Bearer required on the SSE GET.** Some HTTP clients drop the header when upgrading the connection — verify yours sends it.

After creation, open the SSE stream:

```
GET /v1/tasks/:id/stream
Authorization: Bearer <POLPO_GATEWAY_KEY>
Accept: text/event-stream
```

Events arrive in this strict order:

```
event: chunk        data: { "text": "..." }                  # zero or more, assistant output
event: approval     data: { "request": {...} }               # ALWAYS followed by event: error
event: artifacts    data: [{ name, size, mediaType }, ...]   # only if captureArtifacts=true
event: done         data: { "result":{...}, "output":"...", "durationMs":N, "artifacts":[...] }
event: error        data: { "message": "..." }
```

The stream closes after `done` OR `error`. `: ping` comment lines arrive every 15 s — ignore them.

If you missed the stream (network dropped, you connected late), poll `GET /v1/tasks/:id` instead — you'll get the terminal state back as long as the task is still within its 5 min TTL.

### Approvals fail closed

Gateway tasks have **no human in the loop**. If the agent asks permission to use a tool, polpo immediately aborts the task and emits:

```
event: approval data: { request: {...} }
event: error    data: { message: "approval_required" }
```

Treat this as a hard failure. Adjust your prompt so the agent doesn't need to ask: give it explicit instructions and avoid prompts that imply destructive operations the host hasn't pre-authorised.

### Cancellation

🔒 **Auth: Bearer required.**

```
DELETE /v1/tasks/:id
→ 204 (cancelled) | 409 task_already_terminal | 404 task_not_found
```

Cancel any task you started if the user retracted the request or if you misrouted to the wrong host. Don't cancel tasks others started — you'll get `task_forbidden`.

---

## 5. Bidirectional file transfer

### Push files in (`POST /v1/uploads`)

🔒 **Auth: Bearer required.**

```json
POST /v1/uploads
{
  "filename":   "report.pdf",
  "mediaType":  "application/pdf",
  "dataBase64": "<base64-encoded bytes>"
}
```

Constraints (validate before sending):

- `filename`: pattern `[A-Za-z0-9._-]`, ≤ 100 chars. **No `..`, no slashes, no NUL.** Polpo rejects anything else with `400 invalid_filename`.
- Decoded size ≤ 25 MB (host-configurable). Larger → `413 upload_too_large`.
- JSON body (base64 + escaping) ≤ 34 MB.

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

**Always verify `sha256` matches what you sent.** It's the host's confirmation that the bytes arrived intact.

Upload TTL is **1 hour**. Reference the `uploadId` from `POST /v1/tasks` within that window. Polpo pins the upload to the task for the task's lifetime, so it won't be GC'd mid-run.

### Pull files back (`GET /v1/tasks/:id/artifacts*`)

🔒 **Auth: Bearer required** on both the list and the per-file download.

When you set `captureArtifacts: true`, polpo:
1. Creates a sealed output directory for the task
2. Injects a `<polpo:artifacts dir="...">` directive into the prompt telling the agent where to write outputs
3. Seals (hardlink + chmod 0o400) every regular file the agent leaves there when the task finishes
4. Emits an `artifacts` SSE event before `done` listing what survived sealing

After `done`, fetch the list and download each one:

```
GET /v1/tasks/:id/artifacts
→ { "artifacts": [{ name, size, mediaType }] }

GET /v1/tasks/:id/artifacts/:name
→ binary stream (Content-Disposition: attachment, X-Content-Type-Options: nosniff)
```

The artifact name must match `[A-Za-z0-9._-]{1,200}`. Anything else → `400 invalid_artifact_name`.

Artifacts live for **5 minutes** after task completion. Pull them promptly.

What the agent will and won't return:
- ✅ regular files written into the artifacts dir
- ❌ symlinks (refused at seal time)
- ❌ subdirectories (non-recursive)
- ❌ files larger than 25 MB each, or 100 MB aggregate, or more than 100 files (truncated deterministically by name)

If you're asking the agent to generate output for the caller, **explicitly mention the artifacts dir in your prompt** ("write your report to `<polpo:artifacts dir>/report.md`"). The directive polpo prepends tells the agent the path; your prompt should tell it the filename.

---

## 6. Session discovery

🔒 **Auth: Bearer required on all four discovery endpoints.** Search results can contain sensitive snippets from past conversations, so there is no unauthenticated mode.

Use this to route a query to the right session when the user asks about *prior or ongoing* work.

### `GET /v1/sessions/search` — ranked sessions for routing

```
?q=<2..200 chars>&limit=<1..50, default 10>&snippets=<0..5, default 3>
→ {
    sessions: [{
      sessionId,
      instanceId,           // present when the session is currently live
      project, cwd, agentType,
      firstPrompt,          // truncated to 200 chars
      lastActivity,         // epoch ms
      matchCount,
      score,                // higher = more relevant
      topSnippets: [{ snippet, role, timestamp, matchIndex, matchLength }]
    }],
    partial: boolean
  }
```

**Ranking**: `score = matchCount + recencyBoost`. The boost adds up to 5 points for a match today, decaying to 0 at 30 days old. A session with 5 hits today (score ≈ 10) outranks one with 5 hits a year ago (score = 5). Tie-break is `lastActivity` desc.

**This is your default discovery endpoint.** It collapses per-message hits into one entry per session and ranks them so you can pick a single best target.

### `GET /v1/search` — per-message hits

Use only when you need raw individual matches across the host (e.g. for full-text quoting). Same query semantics:

```
?q=<2..200 chars>&limit=<1..100, default 20>&include=<disk|memory|all, default all>
→ { results: [{ sessionId, role, snippet, matchIndex, matchLength, timestamp,
                source: "disk"|"memory", instanceId? }],
    partial: boolean }
```

Sorted newest-first. `instanceId` is set only when `source === "memory"` (the session is currently live on the host).

### `GET /v1/sessions` — catalogue

```
?source=<claude|codex|gemini|opencode|pi|goose|gateway|all, default all>
&days=<1..365, default 30>
&limit=<1..200, default 50>
→ { sessions: [{ sessionId, instanceId?, project, cwd, agentType,
                 firstPrompt, lastActivity, isLive, source }] }
```

`source=gateway` shows only the instances spawned by `POST /v1/tasks` (your peers and previous calls). The other source values filter by agent type. Sorted by `lastActivity` desc, live first.

### `GET /v1/sessions/:id` — read history

Once you've picked a session, pull its messages:

```
?tail=<1..500>            # default: last 100 messages
or ?offset=<int>&limit=<1..500>
→ { messages: [{ role, content, timestamp, type?, contentType?, toolUseId? }],
    total, hasMore, isLive, instanceId }
```

`isLive: true` means the conversation is still active on the host. The `instanceId` is what `/v1/tasks` callers see in their dashboard.

### Validation you must respect

| Constraint | Server response |
|---|---|
| `q` < 2 chars or > 200 | `400 invalid_query` |
| `:id` contains `..`, `/`, `\`, NUL, or control chars | `400 invalid_session_id` |
| `source` not in the allowed enum | `400 invalid_source` |
| `include` not in {disk,memory,all} | `400 invalid_include` |
| Search throughput | `429 rate_limited` (30/min per token for `/v1/search*`, 60/min for the catalogue routes) |

---

## 6b. Delegating a goal to the Alien Mind (`/v1/goals`) — experimental

🔒 **Auth: Bearer required.** Rate limit: 10/min per token.

Use this **instead of `/v1/tasks`** when:
- The work needs decomposition (multiple steps, dependencies between them)
- You want the host to pick agent types, allocate arms, broker context between them
- You're fine with the mind running long (multiple arms, multiple agents, possibly minutes)

Use `/v1/tasks` when:
- You already know exactly what one agent should do
- You need low latency and predictable cost

```
POST /v1/goals
{
  "goal":   "<your high-level instruction, ≤ 50_000 chars>",
  "client": "<your-label>"          // optional
}
→ 201 { goalId, streamUrl }
```

503 `mind_not_enabled` means the host hasn't opted into the mind (`POLPO_MIND=1`). Fall back to `/v1/tasks` and decompose the work yourself.

### SSE event types on `/v1/goals/:id/stream`

```
event: snapshot      data: { goalId, status, prompt, plan, replayed: true }
                                                    ↑ only when you connect late
event: planning      data: { goalId, prompt }
event: plan_ready    data: { goalId, tasks: [{id, description, agentType, dependsOn}] }
event: task_started  data: { goalId, taskId, description, agentInstanceId, agentName, agentType }
event: task_chunk    data: { goalId, taskId, text }
event: task_done     data: { goalId, taskId, success, summary, durationMs }
event: task_failed   data: { goalId, taskId, reason, terminal?, abandoned? }
event: replanning    data: { goalId, taskId, attempt, maxAttempts, reason }
event: cancelled     data: { goalId, reason }
event: done          data: { goalId, status, result, taskSummaries, durationMs }
event: error         data: { goalId, message }
```

Treat the stream as best-effort live: `snapshot` covers your connection-race window; everything after is real-time.

### When to switch from `/v1/goals` back to `/v1/tasks`

- The goal `done` event came back with `status: 'failed'` — inspect `taskSummaries` and re-issue specific failed tasks as targeted `/v1/tasks` calls
- You hit `503 mind_not_enabled` — decompose locally and submit each task individually
- You need file attachments (`/v1/uploads`) — mind goals don't yet accept attachments per task; use `/v1/tasks` for that flow

### Goal-vs-task decision rule of thumb

If you can write the goal as a single sentence ("read the README and summarise"), use `/v1/tasks`. If the user request implies parallelism or dependencies ("refactor X, update its tests, then deploy"), use `/v1/goals` — the mind will plan it. If the host doesn't have the mind enabled, **fall back** rather than failing.

## 6c. Profiling the host (`/v1/profile`)

🔒 **Auth: Bearer required.** Rate limit: 6/min per token. Single in-flight call per host (returns `429 profile_in_progress` while one is running).

Returns a statistics-only report on how this host's operator works with AI agents. **No transcript content is in the response** — only counts, scores, and the archetype label. Useful for deciding how to phrase a task or pick a session:

```
GET /v1/profile?days=<1..365>&agent=<all|claude|...>
→ { archetype: { name, blurb, dimension },
    dimensions: { steering, execution, engineering, productInstinct, planning },  // 0..100
    activity:   { ... },
    tools:      { byCategory, top },
    shell:      { byCategory, gitCommits, testRuns },
    prompts:    { avgWords, codeRatio, ... },
    ...
  }
```

When to use:
- Before composing a prompt, check `dimensions.steering` — if it's high, the operator likes verbose, command-style prompts; if low, lean concise.
- `dimensions.engineering` high → expect the operator wants test-aware, commit-friendly changes; phrase the task accordingly.
- `dimensions.planning` high → propose a plan first; low → just execute.

This is *advisory only*. The operator may override any inference at any time, and they always will. Treat the profile as a starting heuristic, not a contract.

## 7. Multi-node routing (chatbot fan-out)

When the operator runs polpo on multiple machines (laptop, desktop, home server) and the user's question could match any of them:

```
1. for HOST in known polpo nodes:
     hit = GET https://HOST/v1/sessions/search?q=<keywords>&limit=3
     attach `host` to each result

2. winner = argmax(score) across all hits

3. context = GET https://winner.host/v1/sessions/<winner.sessionId>?tail=50

4. either:
   (a) summarise from context and reply to user, OR
   (b) POST https://winner.host/v1/tasks
       with cwd=<context.cwd> and a prompt that references the prior work
```

Do steps 1–3 in parallel across hosts. Don't serialise — the bearer key + per-token rate limits scope per host.

**Important**: a high-score result on one host can be misleading. If two hosts both have plausible matches (scores within 20 % of each other), surface that ambiguity to the user before acting: "Both the laptop and the home server have sessions about the auth refactor. Which one did you mean?"

---

## 8. Prompt-writing rules for one-shot tasks

Because gateway tasks have no human approval loop, your prompt must be **self-sufficient**:

✅ DO:
- State the goal explicitly and concretely
- Name files by absolute path when possible
- Specify the output format and where to write it ("write a one-paragraph markdown summary to `<polpo:artifacts dir>/summary.md`")
- Mention the agent's allowed scope ("only read files under /home/user/spec/")
- Set a realistic `timeoutMs` based on how much work the task involves

❌ DON'T:
- Ask the agent to do anything it would need permission for (sudo, package installs, git push, network requests outside cwd)
- Use vague instructions ("look around and figure it out")
- Reference UI affordances ("click the X button")
- Embed multi-turn workflows in one prompt (each task is one-shot; decompose into multiple `/v1/tasks` calls)

If you encounter `approval_required`, your prompt was too ambitious for the host's permission posture. Either narrow it (read-only tasks) or ask the operator to widen the host's permission policy before retrying.

---

## 9. Worked end-to-end example

The user asks: *"On my home PC, find the most recent discussion of the auth refactor and write me a one-paragraph summary."*

```
1. GET /v1/health
   → confirm reachable, version, activeTasks

2. GET /v1/sessions/search?q=auth+refactor&limit=5
   → [{ sessionId: "abc123", cwd: "/home/marco/dev/myapp",
        project: "myapp", lastActivity: 1730000000000,
        score: 12.3, matchCount: 8,
        topSnippets: [...]
      }, ...]

   Pick sessions[0] — the highest score.

3. GET /v1/sessions/abc123?tail=50
   → { messages: [...], isLive: false, instanceId: null }

   Inspect the messages to confirm relevance.

4. POST /v1/uploads is NOT needed — we have everything we need in the
   conversation. Skip.

5. POST /v1/tasks
   {
     "agentType":  "claude",
     "cwd":        "/home/marco/dev/myapp",
     "prompt":     "Read the most recent ~50 messages of session abc123 by calling out to /v1/sessions/abc123?tail=50 yourself, then write a one-paragraph markdown summary of the auth-refactor decisions to .polpo-out/auth-summary.md. Be concrete: list the affected modules and the chosen approach.",
     "captureArtifacts": true,
     "timeoutMs":  120000
   }
   → { taskId: "gtask-de4d", streamUrl: "/v1/tasks/gtask-de4d/stream" }

   (Alternative: include the messages directly in the prompt rather than
    asking the remote agent to fetch them. Either works; embedding is
    simpler when total context is < 50 KB.)

6. GET /v1/tasks/gtask-de4d/stream (SSE)
   → stream chunks live; wait for event: artifacts and event: done

7. GET /v1/tasks/gtask-de4d/artifacts/auth-summary.md
   → file contents

8. Reply to the user with the summary content.
```

---

## 10. Quick reference card

```
Auth         Authorization: Bearer $POLPO_GATEWAY_KEY  (REQUIRED on every
                                                       single request below;
                                                       no exceptions, no
                                                       anonymous endpoints)
Identify     X-Polpo-Client: <your-label>              (optional, recommended)

Discovery    GET  /v1/sessions/search?q=...
             GET  /v1/sessions?source=...
             GET  /v1/sessions/:id?tail=N
             GET  /v1/search?q=...&include=disk|memory|all

Execute      POST /v1/uploads               body: {filename, mediaType, dataBase64}
             POST /v1/tasks                 body: {agentType, cwd, prompt,
                                                   attachments?, captureArtifacts?}
             GET  /v1/tasks/:id/stream      SSE
             GET  /v1/tasks/:id             snapshot
             DEL  /v1/tasks/:id             cancel
             GET  /v1/tasks/:id/artifacts
             GET  /v1/tasks/:id/artifacts/:name

Profile      GET  /v1/profile?days=N&agent=X   statistics on operator
                                                working style (no transcripts)

Mind goals   POST /v1/goals                 body: {goal, client?}
(experim.)   GET  /v1/goals/:id/stream      SSE (snapshot, planning, plan_ready,
                                                  task_started, task_chunk,
                                                  task_done, task_failed,
                                                  replanning, done | error)
             GET  /v1/goals                 list active goals
             GET  /v1/goals/:id             snapshot
             DEL  /v1/goals/:id             cancel
             503 mind_not_enabled           → host has POLPO_MIND=0; fall back
                                              to /v1/tasks with local decompose

Bounds       q:           2..200 chars
             limit:       1..(50 sessions / 100 messages / 200 catalogue)
             timeoutMs:   <= 30 min (default 5 min)
             upload size: <= 25 MB decoded
             attachments: <= 20 per task
             :id pattern: [A-Za-z0-9._-]{1,200}

Rate limits  search:    30/min per token
             catalogue: 60/min per token
             upload:    60/min per token
             goals:     10/min per token (mind fan-out is expensive)
             profile:   6/min per token (disk scan, 60s cache)

Lifetimes    upload TTL:   1 hour
             task TTL:     5 min after completion
             artifact TTL: 5 min after completion
```

---

## 11. What the gateway does NOT expose

These are explicitly out of scope. Don't ask, don't try; you'll get 404 or 403:

- ❌ **No `POST /v1/sessions/:id/resume`** — you cannot continue an existing session via the gateway. If you need that session's context, read it with `GET /v1/sessions/:id` and embed in a new `POST /v1/tasks` prompt.
- ❌ **No write access to past sessions** — `/v1/sessions/:id` is read-only.
- ❌ **No way to enumerate tokens or other gateway keys** — there's no introspection of the auth state.
- ❌ **No host-level operations** — you cannot list processes, read arbitrary files, or execute shell commands directly. Your only execute path is `POST /v1/tasks`, and what runs there is bound by the spawned agent's permission posture.
- ❌ **No cross-host coordination** — every host is independent. You're the orchestrator if you want fan-out.

---

## 12. When in doubt

- Treat polpo as a **single-host, multi-tenant-future** API: today's bearer key sees everything, but **don't** rely on that — write your prompts and requests as if scoping will be added.
- Treat the host as a **separate user's machine**: don't ask the remote agent to do anything the operator hasn't pre-authorised; surface ambiguity rather than guessing.
- Always **verify what came back**: sha256 on uploads, expected `artifacts` event on captured tasks, status snapshots on `/v1/tasks/:id` if the SSE stream was interrupted.

If you hit a 5xx error you don't understand, report the response body to the operator (the body is sanitised — no filesystem paths or stack traces leak). Don't retry blindly.
