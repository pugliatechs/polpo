# Gateway: Programmatic Agent Execution

The polpo gateway turns the dashboard into a **remote intelligent worker** for external software. Any HTTP client with a valid API key can delegate one-shot agent tasks (Claude, Codex, Goose, Pi, Gemini, OpenCode) to the host running polpo, stream the output back as Server-Sent Events, and exchange files in both directions.

Typical use case: your laptop reaches a home PC over VPN, and an external orchestrator (openclaw, a Slack bot, a CI runner, a custom script) delegates concrete work (read this PDF, generate that document, refactor this file) to the agents installed on the PC.

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
src/server/
  upload-constants.js   # shared UPLOAD_DIR, byte caps, regexes, sanitize helpers
  gateway-auth.js       # Bearer middleware, tokenFingerprint, per-token rate limit
  gateway-uploads.js    # GatewayUploadStore: put/get/pin/release/gcExpired
  gateway-artifacts.js  # GatewayArtifactStore: createDir/sealOnFinalize/openSealed/destroyTask
  gateway-tasks.js      # GatewayTaskManager: task lifecycle, SSE fanout, attachments+artifacts
  gateway.js            # Express router mounted at /v1
```

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
