# Builder Profile

A local, opinionated "how you work with AI agents" report, inspired by YC's Paxel experiment but with Polpo's privacy posture: **nothing leaves the machine**. No LLM calls, no telemetry, no external service. It simply re-reads the session transcripts polpo already has on disk and derives statistics.

## What you get

A single JSON document (or a pretty-printed terminal view) with:

- **Archetype**: one of *The Architect*, *The Shipper*, *The Craftsperson*, *The Director*, or *The Visionary*, plus a one-line description
- **Five 0..100 dimension scores**:
  - **Steering** — how closely you guide the agent turn by turn (prompts per session, prompt length, command-style verbs)
  - **Execution** — hands-on output volume (edits + shell runs per session)
  - **Engineering** — rigor signals (tests run, commits made, read/search share of the tool mix)
  - **Product Instinct** — range and user-focused language (unique projects, product-shaped vocabulary)
  - **Planning** — plan-tool use, structured prompts, code-block ratio
- **Activity**: total sessions, analyzed sessions, active days, peak hour, peak weekday, hour and day-of-week histograms
- **Top agents / models / projects** (top 8-10 each)
- **Tools**: counts grouped into 9 categories (edit / read / search / exec / web / plan / task / mcp / other) plus the top 10 tools by name
- **Shell**: total runs, grouped by category (git / package / test / run / etc.), plus git commit count and test-run count
- **Prompts**: count, average / median / longest word count, question ratio, code ratio, polite ratio, product-vocab ratio

Run the analyzer; the response shape is stable across all surfaces.

## How to read it

Treat the profile as a **mirror, not a verdict**. The dimension scores are heuristic — every signal is documented inline in [src/server/profile-analyzer.js](../src/server/profile-analyzer.js) so you can tune what they mean. Use it for self-reflection ("am I shipping more or planning more this quarter?"), for spotting drift ("my test-run count fell to zero last month"), or for tuning your workflow ("I steer a lot but commit rarely, maybe I'm pair-programming through the agent more than I realised").

Scores **saturate** rather than scaling linearly. A score of 50 means "comfortable amount of this activity"; 80 means "a lot of this"; 100 is asymptotic. Heavy users don't blow the scale and light users still get something legible.

## Privacy posture

The transcripts the analyzer reads are already on this machine (`~/.claude/projects`, `~/.codex/sessions`, etc.). No data egress. No content is hashed, fingerprinted, or stored anywhere new. The profile object contains **statistics**, never raw conversation text, except for the very short archetype blurb (hardcoded in [profile-analyzer.js:152-158](../src/server/profile-analyzer.js#L152-L158)).

If you ever expose the profile via the gateway (see below), keep in mind it does reveal aggregate working patterns — peak hours, projects touched, tool usage — to anyone who holds your gateway key. That's a reasonable surface to share with your own bots; treat it like any other gateway endpoint and keep the key tight.

## How to fetch it

### Dashboard

The sidebar shows a **Builder Profile** card with the radar chart, archetype, and headline stats. Click ↻ to refresh. The card hides itself if the host has no session history yet.

### CLI

```bash
polpo profile                      # last 90 days, all agents, pretty view
polpo profile --days 30            # narrower window
polpo profile --agent claude       # one agent only
polpo profile --days 30 --json     # raw JSON for piping
```

The CLI runs entirely in-process — no server required, no network access.

### Dashboard HTTP API

```
GET /api/profile?days=<1..365>&agent=<all|claude|codex|gemini|opencode|pi|goose>
Authorization: <whatever dashboard auth the host runs>
```

60-second response cache, single in-flight call per host.

### Gateway HTTP API (`/v1/profile`)

```
GET /v1/profile?days=<1..365>&agent=<all|claude|codex|gemini|opencode|pi|goose>
Authorization: Bearer <POLPO_GATEWAY_KEY>
```

Same response shape as `/api/profile`. Per-token rate limit: 6/min (it's an expensive scan). Single in-flight call per host (concurrent calls return `429 profile_in_progress`). Server-side cache 60 s.

Use this when an external agent wants to introspect its host — "what's the operator's working style on this machine?" — before deciding how to phrase a task or which session to resume.

## Configuration

Both endpoints accept the same query parameters and obey the same bounds:

| Param | Default | Range |
|---|---|---|
| `days` | 90 | 1..365 |
| `agent` (or `source`) | `all` | `all`, `claude`, `codex`, `gemini`, `opencode`, `pi`, `goose` |

The analyzer also has two non-exposed knobs (in `profile-analyzer.js`):

| Constant | Default | Meaning |
|---|---|---|
| `DEFAULT_MAX_ANALYZED` | 200 | Cap on number of sessions whose full history is loaded for content metrics |
| `DEFAULT_DEADLINE_MS` | 15 000 | Wall-clock budget for the content pass |

Sessions beyond the cap or deadline are still counted in metadata aggregates but don't contribute to tool / shell / prompt statistics. The profile reports `analyzedSessions` separately from `totalSessions` so the truncation is never silent.

## Heuristic transparency

Every signal that feeds a dimension score is documented inline in [src/server/profile-analyzer.js](../src/server/profile-analyzer.js). For example, **Engineering** weighs tests run + commits made + read/search share of the tool mix; **Planning** weighs `TodoWrite` and `ExitPlanMode` calls plus structured-prompt signals. If the scores feel off for your workflow, the math is in 200 lines you can read and tune. Pull requests welcome.

## Why this exists in Polpo

YC's Paxel report (similar feature, cloud-hosted) showed that developers find their own working patterns surprisingly hard to estimate. Polpo already has the raw material — transcripts from every agent, normalized into a uniform shape — so producing the same kind of self-reflection report is a hundred lines of analysis, no AI required, no third party in the loop. It's a natural fit for a tool whose entire pitch is "your dev work, on your machine, you in control".

## Caveats and limitations

- **Statistical, not semantic.** The analyzer counts and categorizes; it doesn't understand the content. A session full of bash one-liners that solve a deep problem looks the same as a session full of trivial debugging.
- **Tool name matching is regex-based.** Custom MCP tools that don't follow the `mcp__` prefix may end up in `other`. The categorizer is documented at the top of `profile-analyzer.js` if you need to add patterns.
- **No comparisons.** There's no leaderboard, no "you vs. other developers" benchmark. The profile is a self-mirror, period.
- **Heuristics drift.** Default thresholds (the `saturate(value, midpoint)` midpoints in `scoreDimensions`) are calibrated against a sample of one author's transcripts. If they consistently misrepresent your work, tune them. We're keeping the implementation small and opinionated rather than offering a knob for every signal.
