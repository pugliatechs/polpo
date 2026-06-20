# Session Outbox

Agent → phone file transfer for dashboard sessions. The reverse direction of the existing phone → agent attachment flow (paperclip icon).

When outbox is on, polpo prepends a directive to every prompt telling the agent where to drop output files. When the agent goes idle, any new files appear as download chips on the assistant's response bubble. The user taps a chip to download.

This is the **dashboard-side mirror** of the gateway's sealed-artifact pattern (`<polpo:artifacts>`), tuned for long-lived sessions instead of one-shot tasks.

## When to use it

- You want the agent to produce a report, CSV, PDF, packed zip, generated image, or any other downloadable file.
- You want the file to survive the agent process (which is killed mid-session by `--watch` reloads, or simply terminates at session end).
- You want the dashboard to surface the file without you having to remember its filename or hunt around `/tmp/`.

Don't use it for:

- Files you want shared between two arms of an Alien Mind goal — use the world-model + inter-arm context instead.
- Files the agent reads from but never writes to — those go through the existing paperclip-upload path.
- Pure conversational output (the answer goes in the assistant message, not in a file).

## Lifecycle

```
1. Tap the 📂 OUTBOX pill in the active session's header.
       └─→ POST /api/instances/:id/outbox/enable
       └─→ server creates <tmpdir>/polpo-session-outbox/<hash(id)>/ (mode 0700)
       └─→ pill turns on; state mirrored in the dashboard.
2. Type a prompt and send.
       └─→ websocket layer rewrites the prompt to prepend:
             <polpo:outbox dir="<absolute path>" max-files="100" max-bytes="100000000">
             If you produce output files the user should be able to download,
             save them into the directory above.
             Only regular files written directly into that directory will be
             exposed. Symlinks, subdirectories, and oversized files are ignored.
             Filenames must match [A-Za-z0-9._-] and be at most 200 chars.
             </polpo:outbox>
       └─→ agent reads the directive, writes files into the dir as it works.
3. Agent goes idle.
       └─→ server diffs the dir against its previous snapshot.
       └─→ websocket layer broadcasts:
             { type: 'outbox_update', instanceId, newFiles: [...names], files: [...metadata] }
       └─→ dashboard attaches the new files as ⬇ chips to the most recent
           assistant bubble.
4. User taps a chip.
       └─→ GET /api/instances/:id/outbox/:name
       └─→ server validates name + prefix-checks the resolved path,
           streams the file with Content-Disposition + nosniff.
5. (Optional) tap the pill again to disable.
       └─→ POST /api/instances/:id/outbox/disable
       └─→ server rm -rf's the dir; pill turns off.
6. Session disconnect.
       └─→ instance:disconnected listener auto-disables + removes the dir.
```

## Security

- **Server-controlled paths.** The outbox dir name is `sha256(instanceId).slice(0, 32)`, so an attacker who controls the instance id can't escape `<base>/`. The id is never interpolated into a filesystem path directly.
- **Filename whitelist.** Only `[A-Za-z0-9._-]{1,200}` is exposed. Files written with spaces, slashes, or NUL are silently dropped from listings and refused by the download path.
- **Prefix check.** Every download resolves the absolute path and verifies `resolved.startsWith(dir + path.sep)` BEFORE opening a read stream. Symlinks pointing outside the dir get caught here.
- **Subdirs and symlinks ignored.** `readdir({ withFileTypes: true })` + `isFile()` filter means only regular top-level files surface in listings.
- **Aggregate caps.** 100 files max, 100 MB total. Files past either cap are silently dropped from listings — a runaway agent can't fill the host's disk via this path.
- **Defence in depth on response.** `Content-Type: application/octet-stream` + `Content-Disposition: attachment` for non-image files; `X-Content-Type-Options: nosniff` always. Inline-safe images (PNG/JPG/JPEG/GIF/WEBP/SVG) keep their media type so the dashboard renders thumbnails — same whitelist the dashboard already uses for user-uploaded attachments.
- **Dashboard auth applies.** The outbox routes mount under `/api`, which is behind the dashboard's existing Bearer/session middleware. No separate token, no public path.
- **Mode bits.** Per-instance dir is `0o700`; contents are whatever the agent writes (typically `0o644` because that's what most tools produce; the dashboard never relies on permissive modes).

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/instances/:id/outbox/enable` | Enable outbox for this session. Creates the dir if absent. Returns `{ enabled: true }`. |
| POST | `/api/instances/:id/outbox/disable` | Disable outbox and `rm -rf` the dir. Returns `{ enabled: false }`. Idempotent. |
| GET | `/api/instances/:id/outbox` | List current files. Returns `{ enabled, files: [{ name, size, mediaType, mtime, isInlineSafe }] }`. |
| GET | `/api/instances/:id/outbox/:name` | Download a specific file. 400 `invalid_name`, 404 `file_not_found`, 409 `outbox_not_enabled`. |

WebSocket event (server → dashboard):

```js
{ type: 'outbox_update', instanceId, newFiles: ['report.csv', 'chart.png'], files: [...] }
```

Fired when an instance with outbox enabled transitions to `idle` AND the dir contains at least one file that wasn't in the previous-idle snapshot. `newFiles` is sorted newest-first by mtime. `files` is the full current listing (the dashboard uses it to look up size + media-type for each new name).

## Implementation notes

- **One persistent dir, not per-turn.** Earlier sketches proposed per-turn dirs that get sealed when the agent idles. That matches the gateway exactly (each gateway task gets its own sealed dir) but is over-engineered for a dashboard session, where files frequently get edited across turns ("can you add a header to commits.csv?"). One dir per session, diffed at each idle transition, is simpler and matches user intuition.
- **No sealing.** The dir stays writable throughout the session. The gateway needs sealing because a one-shot task can be downloaded long after the agent has exited; the dashboard's per-session dir is destroyed on disconnect so TOCTOU between list-and-download is bounded by "is the agent still running, and could it overwrite this file?". Inside a trusted session that's not a concern.
- **Directive injection happens in the websocket layer, not the agent.** Polpo rewrites the prompt before forwarding it to the agent process. The user's text in the conversation log is what they actually typed; the directive is internal plumbing.
- **`@outbox` shorthand was considered and rejected.** A magic prefix like `@outbox` in the user's prompt to opt in for a single turn was tempting but adds a parser surface area for prompt injection. The toggle pill is more explicit and less spoof-able.
- **Mind arms inherit nothing.** The Alien Mind's one-shot arms don't get a session outbox because they're not interactive: there's no "phone next to me waiting" to download anything. Mind tasks that need to produce files should use the gateway's existing `captureArtifacts: true` mechanism, which is byte-for-byte the same sealing flow the HTTP gateway exposes.

## Limits

| What | Cap |
|------|-----|
| Files per outbox | 100 |
| Aggregate bytes | 100 MB |
| Filename length | 200 chars |
| Filename charset | `[A-Za-z0-9._-]` |

These are tunable via the module exports (`MAX_FILES`, `MAX_AGGREGATE_BYTES`) but no env-var override is exposed for v1.2.1.
