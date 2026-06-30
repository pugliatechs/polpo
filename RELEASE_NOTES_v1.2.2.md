# Polpo v1.2.2 — release notes

**Theme.** v1.2.2 is the interaction-and-honesty release. The Alien Mind stops being fire-and-forget — it now shows you the plan before dispatching, asks before escalating a blocker, and surfaces both as one-tap buttons in chat. The gateway grows a model-override knob so Goose + Ollama (and similar provider-routed agents) work end-to-end through external callers. Costs widget retires because it lied to anyone not running Claude API directly. Sidebar gets a "View all sessions" modal instead of infinite-scrolling the page. And the README finally stops calling polpo a "Claude Code controller" — it's a multi-agent orchestrator with three access surfaces (dashboard, Alien Mind, /v1 gateway).

## Headline changes

1. **Alien Mind: plan approval + escalation, with buttons.** Submit a goal in chat → the mind shows a plan preview with `[ Approve ]  [ Tweak… ]  [ Abandon ]` buttons inline. When an arm gets stuck past the replan budget, the mind escalates with `[ Retry… ]  [ Skip ]  [ Abandon ]`. No more typing slash-commands; mobile-first one-tap UX. Plus the underlying eval-failure gap is closed: a task that "completes" but actually refused now routes through the replan path.
2. **Goose + Ollama via the gateway.** `POST /v1/tasks` now accepts an optional `model` field. The gateway treats it as opaque; each agent interprets in its own format (`ollama/qwen2.5`, `claude-opus-4-7`, `gpt-5`, `anthropic/claude-haiku-4-5`, etc.). Unlocks local-LLM use cases for external callers.
3. **Mobile setup QR codes in the dashboard.** Running `--trust-localhost --auth paranoid --tunnel cloudflared`? Open the dashboard from the same machine and you'll see a "Mobile setup" card with scannable QRs for the authenticator app + tunnel URL. Solves the "screen scrollback ate my startup QR" problem without writing the token to disk.
4. **"All sessions" modal replaces the page-level infinite scroll.** Sidebar shows the 12 most recent sessions plus a "View all (N) →" link that opens a full-browse modal with search, agent-type filter chips, and its own internal infinite scroll. Sections below (Profile, mobile-setup QRs) stay reachable.
5. **Single-user expectations made explicit.** README now states polpo is a single-user application and warns against running two polpo servers on one host. The supported multi-instance pattern is "one polpo per UID."

## Behavioural changes worth flagging

- **Chat goals now wait for `/approve` by default.** Goals submitted through the mind's chat hold dispatch until you reply. To skip per-goal, prefix with `/auto ` (e.g. `/auto Refactor the auth module`). To opt out globally, set `POLPO_MIND_AUTO_DISPATCH=1` before starting polpo. Goals submitted through `POST /v1/goals` always auto-dispatch (no chat for them to wait on).
- **Mind watcher no longer nags about your own sessions.** Alerts in the mind's chat are now scoped to mind-spawned arms (`source: 'mind:<goalId>'`). User-started Claude/Codex/Gemini/OpenCode/Pi/Goose sessions awaiting tool approval keep their per-instance modal in the dashboard; the mind chat stays quiet about them.
- **Cost widget gone.** The sidebar costs card, `/api/costs`, the `instance:cost` WebSocket event, the `$X · N turns` prefix on assistant bubbles, and the `cost_usd` field on Claude `turn_complete` payloads are all removed. Builder Profile remains as the "how much have I been working" view. Your existing `~/.config/polpo/costs.jsonl` is left intact — nothing reads it anymore but the file isn't deleted on upgrade.
- **Inline buttons replace slash-command typing** for `/approve`, `/tweak`, `/abandon`, `/retry`, `/skip` in mind chat. Typing still works for muscle memory + accessibility.

## Removed API surface

| What | Replacement |
|---|---|
| `GET /api/costs` | No replacement — feature removed. Builder Profile covers activity. |
| `instance:cost` WS event | No replacement. |
| `cost_usd` in `turn_complete` messages | No replacement. `num_turns` is still emitted. |
| Page-level infinite scroll on `/api/sessions` (still works server-side) | The "All sessions" modal consumes pagination internally. |

No breaking changes to the `/v1` gateway. The `POST /v1/tasks` body grew one optional field (`model`); the response shape gained the field in `GET /v1/tasks/:id`. Older callers ignore.

## Upgrade notes

- **No migration required.** Run `npm install` after pulling. The on-disk format of `~/.config/polpo/` is unchanged.
- If you want to remove the historical cost data: `rm ~/.config/polpo/costs.jsonl`. Polpo no longer touches that file.
- If you have a habit of running multiple polpo servers on different ports — stop, or run them as separate UNIX users. See the new "Single-user, by design" section in the README.

## Commits

### Features

* **gateway:** optional model override on POST /v1/tasks ([f424c34](https://github.com/pugliatechs/polpo/commit/f424c34))
* **server,web:** mobile setup QR codes for trust-localhost dashboards ([b367fa9](https://github.com/pugliatechs/polpo/commit/b367fa9))
* **mind:** interactive plan approval + escalation on blocker ([ea4de1e](https://github.com/pugliatechs/polpo/commit/ea4de1e))
* **mind,web:** inline action buttons for plan approval + arm escalation ([a085792](https://github.com/pugliatechs/polpo/commit/a085792))
* **server,web:** paginate + cache /api/sessions; "View all" modal replaces infinite scroll ([12d2e1d](https://github.com/pugliatechs/polpo/commit/12d2e1d))

### Bug Fixes

* **mind:** watcher only alerts on mind-owned arms, not user sessions ([bc5b9e3](https://github.com/pugliatechs/polpo/commit/bc5b9e3))

### Refactoring

* **server,web:** remove cost dashboard — misleading for non-Claude agents ([a6472e1](https://github.com/pugliatechs/polpo/commit/a6472e1))

### Documentation

* reframe Polpo as multi-agent orchestrator, not Claude Code controller ([a05880a](https://github.com/pugliatechs/polpo/commit/a05880a))
* state explicitly that polpo is single-user; warn against multi-instance ([6038a6e](https://github.com/pugliatechs/polpo/commit/6038a6e))

## Stats

- **9 commits** since v1.2.1
- **732 / 732 tests** passing
- **0 new runtime dependencies** in `dependencies` (qrcode was added in v1.2.1's earlier work; v1.2.2 adds none)
- **~1 KB** of `~/.config/polpo/costs.jsonl` per user is now stale on disk (harmless; rm if you like)

## Release process

This release follows the standard release-please flow. The PR auto-generates the CHANGELOG.md entry from the conventional-commit prefixes; the "Headline changes," "Behavioural changes," "Removed API surface," and "Upgrade notes" sections above can be pasted into the GitHub Release body when the tag fires, or merged into the CHANGELOG.md entry inside the release-please PR (the v1.2.1 release used this pattern).

If the auto-computed version is wrong (semver-correct from 5 `feat:` commits → `1.3.0`, but the intent is `1.2.2`), push an empty commit with footer:

```
Release-As: 1.2.2
```

before merging the release PR.
