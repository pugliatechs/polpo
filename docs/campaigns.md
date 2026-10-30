# Campaigns: Human-Directed Agentic Engineering in polpo

**Status:** phase 1 is built (section 8): the campaign file and its pin,
binding to a session, gates on demand, the ledger and its export, pending
decisions on the dashboard, the phone and the gateway, and approvals that
wait for you. Phases 2 to 4 are design.

A campaign is a long-running piece of work, days or weeks, done by one
coding-agent session against milestones and executable gates that you
define. polpo runs the gates, keeps the agent going between your
decisions, brings each decision to you wherever you are, and records how
the work was steered.

"Wherever you are" includes an external agent. A personal assistant
connected to Telegram, Slack or anything else can sit between you and the
campaign through the gateway: it is told when a decision is needed, puts
it to you in your chat, and carries your answer back. Every decision a
campaign needs can travel that way (section 4.10).

The method comes from Gregory Kurtzer's report on Ginux, a research kernel
built in eleven days by one persistent coding-agent task under what he
calls Human-Directed Agentic Engineering (HDAE) [1]. This document takes
the method as the report describes it, says what polpo already has for
it, and designs the rest.

## 1. HDAE in brief

The report describes two coupled loops:

- **Outer steering loop (the human):** vision, architecture and
  constraints, an acceptance gate, human review of observed behaviour,
  then correction, reprioritisation or acceptance.
- **Inner agent loop (the agent):** implementation, build and run,
  measurement and failure analysis, revision, regression test. It runs
  until the gate passes or a result needs a human architectural decision.

What made it work, in the report's own account:

1. **Plans live outside the conversation.** Architecture, a compatibility
   ledger, a working goal and decision records, all versioned in the
   repository.
2. **Gates are a ladder.** Each stage ends in an observable gate, and the
   next gate exercises the previous work in a less synthetic context. "A
   printed success message never completed a stage by itself."
3. **The inner loop is executable by the agent.** Repository scripts ran
   the system headless, checked expected markers and timeouts, and
   reported. The agent could iterate without a human watching.
4. **The human rejects false success.** Plausible demonstrations that
   violated the intended semantics were the main risk; operator tests
   "repeatedly exposed false success", and each finding became a new
   task and, where possible, a regression gate.
5. **Accepted decisions are written back** into the documents, plan and
   regression suite before the next milestone starts.
6. **Stopping is a human decision.** "The compatibility campaign could
   continue indefinitely."

What the report says it could not preserve (section 5.3): the conversation
export, exact tool versions, and "a machine-readable pass/fail manifest".
Its steering chronology was curated by hand afterwards.

## 2. Why not the Alien Mind

The mind is the obvious place to look, and it is the wrong executor. It
differs from HDAE on the three things that matter most:

| | Alien Mind | HDAE |
|---|---|---|
| Who plans | the reasoner decomposes the goal; you approve the plan | you write the architecture, milestones and gates |
| Who decides success | the reasoner reads the arm's output | gates run outside the agent, then you accept |
| Agent continuity | a fresh process per task, by design | one session for days |
| Time scale | 15 to 45 minutes per task; goals are lost on restart | days to weeks; must survive restarts |
| Shape | parallel fan-out across projects | one milestone at a time |

Each row of the mind's column is deliberate. Its documentation defends
one-shot arms as the thing that removed a class of reuse bugs, and its
reasoner judging success is exactly the false success HDAE exists to
catch. Bending the coordinator into a campaign engine would break the
first and keep the second.

A second mechanism beside the mind is not the answer either. The campaign
module is built from parts polpo already has, the mind's among them.

## 3. What polpo already has

| Need | Existing piece |
|---|---|
| One session that lives for days | held sessions (`SessionController`): same session id via `--resume`, survives a polpo restart |
| You and polpo never writing at once | the one-writer rule: busy means read only; a session written to in VSCode is handed back |
| Reaching you away from the desk | dashboard, phone push, approvals on the phone, the gateway for a PA |
| A sensible permission mode for long runs | sessions keep the mode they had at the desk |
| Asking you a decision in chat | the mind's `/approve` `/tweak` `/abandon` and escalation `/retry` `/skip` patterns |
| Telling a finished turn from a question or a refusal | `Reasoner.assessTurn` and the stop reason carried from the agent |
| Noticing a stuck agent | the mind's `Watcher` |
| Durable state across restarts | the `GoalStore` pattern (atomic JSON under `~/.config/polpo`, mode 0600) |
| Secrets kept out of what leaves the host | gateway redaction |

What is missing: a campaign definition, a gate runner, the inner-loop
driver, milestone verdicts, and a steering record.

## 4. Design

```
                  you (desk, phone, PA)
                          |
          verdicts, prompts, approvals, stop
                          |
  +-----------------------v------------------------+
  | Campaign (src/campaign/)                       |
  |                                                |
  |  CampaignFile   pinned definition from repo    |
  |  GateRunner     runs gates outside the agent   |
  |  Driver         inner loop between decisions   |
  |  Ledger         append-only steering record    |
  |  CampaignStore  state across restarts          |
  |  Advisor        optional, the mind's reasoner  |
  +-----------------------+------------------------+
                          |
              SessionController (one held session)
                          |
                  coding agent (claude, codex, ...)
```

### 4.1 The campaign file

You own it; it lives in the repository so it is versioned with the work.
Default path `.polpo/campaign.json`. JSON, because polpo adds no
dependencies. You rarely type it by hand: the PA or the agent drafts it,
and you approve it through a `definition` decision, which polpo renders as
a readable ladder (milestone, gate command, acceptance text, budgets), not
as raw JSON.

```json
{
  "version": 1,
  "name": "storage-engine",
  "objective": "Replace the in-memory index with a crash-safe on-disk engine",
  "read_first": ["ARCHITECTURE.md", "docs/decisions/", "docs/storage-spec.md"],
  "constraints": [
    "public API in src/api/ does not change",
    "no new runtime dependencies"
  ],
  "milestones": [
    {
      "id": "m1-format",
      "goal": "On-disk format with a versioned header and checksums",
      "gate": { "run": ["make", "test-format"], "timeout_s": 600 },
      "accept": "round-trips every fixture; a flipped byte is detected"
    },
    {
      "id": "m2-recovery",
      "goal": "Crash recovery",
      "gate": { "run": ["make", "test-crash"], "timeout_s": 1800 },
      "accept": "kill -9 at any of the 200 injected points loses no acknowledged write"
    },
    {
      "id": "m3-real-load",
      "goal": "Runs the production replay",
      "gate": { "run": ["make", "replay"], "timeout_s": 3600 },
      "accept": "same answers as the in-memory index on the full replay"
    }
  ],
  "pinned_paths": ["Makefile", "tests/gates/"],
  "budgets": { "turns_per_milestone": 60, "hours_per_milestone": 12, "same_failure_limit": 4 },
  "stop": "m3-real-load accepted, or my call"
}
```

- `milestones` are the ladder, in order. Each gate is an argv array run
  without a shell; anything more complex goes in a script.
- `accept` is prose for you, shown on the verdict. polpo does not judge
  it; a passing gate only means the verdict is ready to be asked.
- `read_first` is what the agent is told to read at the start of each
  milestone and after each restart: the plan outside the conversation.

**Pinning.** When you approve the campaign, polpo stores the file's hash
and the hashes of `pinned_paths` outside the repository, in
`~/.config/polpo/campaigns/<id>/`. The agent works in the repository and
can edit the campaign file and the gate scripts; it cannot edit the pin.

- A changed campaign file pauses the campaign until you approve it again,
  with the diff. The agent cannot move the goalposts.
- A changed pinned path does not pause: adding regression tests is part
  of the job. The verdict lists every pinned path that changed since the
  milestone began, with the diff, so a weakened gate is in front of you
  when you decide.

### 4.2 Binding to a session

A campaign binds to one session, new or existing, through
`SessionController`. polpo holds it as `campaign:<id>`. The one-writer
rule is unchanged:

- While polpo holds it, the driver may prompt it.
- When you write to it in VSCode or a terminal, polpo hands it back and
  the campaign pauses (`paused_desk`). Your turns are still observed: gates
  still run when your turns end, and your prompts go into the ledger as
  desk interventions.
- The campaign resumes when you say so, and only once the session is
  idle: polpo raises a `resume` decision when the session goes idle, which
  you can answer from the dashboard, the phone or your PA. Stepping away
  from the desk for a few minutes does not hand the session back to polpo.
  A campaign can opt into resuming on its own after a quiet period
  (`"resume_after_idle_minutes": 30`); it is off by default.

The session keeps the permission mode it had at your desk. A campaign is
never bypassed.

**Approvals wait for you.** Outside campaigns, an approval nobody answers
is denied after five minutes: right for a session you are watching, wrong
for one that runs for days. In the October 10 run that rule spent half an
hour on six expired approvals and taught the agent to work around them.
In a campaign, an approval becomes an `approval` decision on the
dashboard, the phone and the gateway, and the agent waits for your
answer. The budget clock stops while it waits, so time spent waiting for
you is not charged to the milestone.

### 4.3 Gate runner

polpo runs the gates itself, as the user polpo runs as, in the session's
working directory.

- **When:** after every turn that ends normally and changed the working
  tree (HEAD moved, or the diff hash changed), and on demand (`/gate`).
  A turn that only talked does not rerun a 30-minute gate.
- **How:** argv, no shell, the milestone's timeout, output to a log file.
- **Recorded:** gate id, commit, dirty-tree hash, exit code, duration,
  the log's sha256 and its tail, and the agent and model versions where
  the agent reports them.

The agent is never asked whether its gate passed. That is the point.

### 4.4 Driver: the inner loop

Between your decisions:

1. A turn ends. The gate runs.
2. **Gate fails:** the driver sends the agent the gate's id, exit code and
   the last 200 lines of output, with the active milestone, and the agent
   continues.
3. **Gate passes:** the campaign moves to `awaiting_verdict` and asks you
   (4.5). The driver sends nothing until you answer.
4. **The agent asks a question** (`assessTurn` says `needs_input`): it goes
   to you as a `question` decision, on the dashboard, the phone or through
   your PA. HDAE keeps architectural decisions human,
   so the mind's practice of answering an arm itself is not used here.
5. **The turn ended in a refusal:** you are told; the driver does not push
   the agent at the blocked action again.

Budgets pause the loop and ask you; they never end the campaign:

- `turns_per_milestone` and `hours_per_milestone`.
- `same_failure_limit`: the same gate failing with the same failure
  signature (exit code plus the normalised last lines) this many times in
  a row means no progress.
- The `Watcher`'s stuck detection, reused, for a turn that never ends.

Time spent waiting on any of your decisions is not counted. Cost is shown
where the agent reports it (Claude does) but is not a budget: polpo cannot
measure it for every agent, and a budget that only works for some agents
would be a surprise for the others.

### 4.5 Milestone verdicts

A passing gate produces a verdict request: the milestone, its `accept`
text, the gate result, the commits since the milestone began, and the
changed pinned paths. It reaches you as a card on the dashboard and the
phone (a new approval type beside `tool`, `plan` and `question`), with a
push notification, and through the gateway for a PA.

| Verdict | What happens |
|---|---|
| **accept** | Recorded. The agent is told to write back the decisions and requirements from this milestone into the documents, plan and regression suite; the next milestone starts when that turn ends. |
| **reject** with a reason | Recorded as rejected false success. The reason goes to the agent as its next task, with the instruction to add a regression gate that fails on it. The milestone stays active. |
| **redirect** with text | Reprioritise or correct: the text goes to the agent; the milestone stays active. |
| **stop** | The campaign ends here. Only you can do this. |

### 4.6 The steering record (ledger)

Every intervention is appended to
`~/.config/polpo/campaigns/<id>/ledger.jsonl` (mode 0600):

```json
{"seq":42,"at":"2026-11-03T21:14:07Z","kind":"verdict","verdict":"reject",
 "milestone":"m2-recovery","channel":"phone","commit":"a1b2c3d",
 "reason":"recovery replays the journal twice after a torn header",
 "prev":"<sha256 of entry 41>"}
```

- **Kinds:** `campaign_created`, `campaign_approved`, `definition_rejected`,
  `campaign_changed`, `prompt`, `approval`, `denial`, `approval_expired`,
  `gate_run`, `verdict`, `budget_pause`, `pause`, `handback`, `resume`,
  `question`, `answer`, `refusal`, `stop`.
- **Channels:** `desk` (seen in the transcript), `dashboard`, `phone`,
  `gateway:<client>`, `polpo` (the driver itself).
- **Hash-chained:** each entry carries the hash of the previous one, so a
  gap or an edit is detectable.
- Text goes through the same secret filter as the gateway before it is
  written.

`polpo campaign export <id>` writes the two things the report could not:

- `manifest.json`: per milestone, every gate run with commit, result and
  log hash, and the verdict with its channel. Machine-readable pass/fail.
- `STEERING.md`: the chronology, generated from the ledger.

The ledger is also the evidence that earned autonomy (granting a class of
actions more autonomy once you have approved it enough times) needs later.
Approvals outside campaigns would write to the same format.

### 4.7 CampaignStore and restarts

Campaign state (definition hash, active milestone, budgets used, status)
is kept like `GoalStore` keeps goals, in
`~/.config/polpo/campaigns/<id>/state.json`, rewritten atomically. Unlike
mind arms, a campaign's session can be resumed: after a polpo restart the
campaign comes back `paused` and raises a `resume` decision; answering it
continues the campaign on the same session id. Pending decisions survive
the restart with it.

### 4.8 Advisor: the mind, without a vote

When the mind is enabled, its `Reasoner` advises; it never decides.

- **Drift:** every few turns it compares the turn's diff with the active
  milestone and flags work that wandered off it. The report notes that one
  model family spent effort on side paths that later had to be undone;
  this makes that visible instead of anecdotal. A flag is a note to you,
  not an action.
- **Investigations** (`/investigate <question>`): a one-shot, read-only
  run through `OneShotAgentRunner`, the way the mind runs arms, to
  diagnose a failing gate or read a spec without spending the main
  session's context. Its result is posted for you, not injected.
- **Turn classification:** `assessTurn` tells a finished turn from a
  question or an interrupted one, as in the mind.

### 4.9 Dashboard and phone

A campaign card on the bound session shows the milestone ladder, gate
history and budgets, with verdict, question and approval cards. Commands
in the campaign's chat: `/gate`, `/resume`, `/pause`, `/stop`,
`/investigate`, `/status`.

### 4.10 Directing from anywhere: the gateway

The outer loop needs you to answer, not to sit at a screen. An external
agent (a PA on Telegram, Slack, Signal, a voice assistant) can carry every
decision between you and the campaign. polpo stays platform-neutral: it
exposes decisions and accepts answers; the PA owns the chat platform.

#### Decisions are objects

Everything a campaign waits on is a **pending decision**, the same object
on every surface:

```json
{
  "decisionId": "dec-7f3a",
  "campaignId": "storage-engine",
  "kind": "verdict",
  "milestone": "m2-recovery",
  "createdAt": "2026-11-03T21:10:44Z",
  "text": "Milestone m2-recovery passed its gate (make test-crash, 14m02s, commit a1b2c3d).\nAccept when: kill -9 at any of the 200 injected points loses no acknowledged write.\nGate files changed since the milestone began: tests/gates/crash.sh (+12 -3).",
  "options": ["accept", "reject", "redirect"],
  "needsText": { "reject": "why it is not done", "redirect": "what to do instead" },
  "details": { "gate": { "exit": 0, "logSha256": "..." }, "commits": 17, "diffUrl": "/v1/campaigns/storage-engine/decisions/dec-7f3a/diff" }
}
```

- `kind` is one of `definition` (approve a new or changed campaign file,
  rendered as a readable ladder), `verdict`, `question` (the agent asked
  something), `budget` (a budget ran out: continue, raise it, or pause),
  `approval` (the agent wants to run something its permission mode does
  not allow; the text shows the tool and its input, secrets filtered),
  `resume` (the session is idle again after you worked at the desk).
- `text` is ready to forward: plain text, no markup, under 3,500
  characters, secrets filtered. A PA can relay it as it is, or summarise
  it, but the full text is what you decided on.
- `options` are the only valid answers; `needsText` says which need a
  reason.

#### Being told: poll or webhook

- **Poll:** `GET /v1/decisions?since=<cursor>` returns pending decisions
  across campaigns and a cursor. Works over any tunnel, including
  Cloudflare quick tunnels, which do not carry Server-Sent Events.
- **Webhook:** with `POLPO_CAMPAIGN_WEBHOOK_URL` set, polpo POSTs each new
  decision and each campaign event (paused, resumed, milestone accepted,
  stopped, gate failed if you ask for those) as it happens, so the PA can
  write to you within seconds. Each request carries
  `X-Polpo-Signature: sha256=<HMAC of the body>` with a secret polpo
  generates and keeps beside the gateway key. The URL must be https or
  loopback. Delivery retries with backoff and never blocks the campaign;
  polling still works if the webhook is down.

#### Answering

```
POST /v1/campaigns/:id/decisions/:decisionId
{
  "answer": "reject",
  "text": "recovery replays the journal twice after a torn header",
  "relay": { "decidedBy": "user", "userMessage": "no, it double-replays after a torn header" }
}
```

- **First answer wins.** The same decision is open on the dashboard, the
  phone and the gateway at once. The first valid answer closes it; any
  later one gets `409 decision_closed` with what was decided and where.
- **No stale answers.** A decision is tied to the state it was asked
  about. If the campaign moved on (a newer commit, the definition
  changed), the decision is superseded and a late answer gets
  `409 decision_superseded`.
- **Definitions are approved by hash.** A `definition` decision carries
  the file's hash; the answer must echo it, so a PA cannot approve a
  version other than the one it showed you.

#### Relay attestation

polpo cannot see your Telegram chat, so it cannot know whether an answer
came from you or from the PA's own judgement. It asks, and records:

- `relay.decidedBy`: `user` (you answered, the PA passed it on) or
  `agent` (the PA decided).
- `relay.userMessage`: your words, verbatim, when you answered. Stored in
  the ledger through the secret filter.

The host decides what a PA may decide on its own, per kind, with
`POLPO_CAMPAIGN_AGENT_MAY`. The default is nothing: every answer must be
`decidedBy: user`, the PA relays and you decide. Only `question`,
`budget` and `resume` can ever be listed; `definition`, `verdict` and
`approval` are always yours, and polpo refuses to start with any of them
in the list. The intended way to widen it is evidence: after a campaign,
the ledger shows which kinds of decision you always answered the same
way. An answer that claims
`decidedBy: user` is taken as such and recorded with its channel; the
ledger shows exactly which decisions were relayed and which were made on
the PA's own, so a PA that misreports is visible afterwards.

#### What a PA can do

| Route | Needs |
|---|---|
| `GET /v1/campaigns`, `GET /v1/campaigns/:id` (ladder, gate history, budgets) | the gateway key |
| `GET /v1/campaigns/:id/ledger?since=<seq>` | the gateway key |
| `GET /v1/decisions?since=`, `GET .../decisions/:id/diff` | the gateway key |
| `POST /v1/campaigns/:id/decisions/:decisionId` | `POLPO_GATEWAY_CAMPAIGN_CONTROL=1` |
| `POST /v1/campaigns/:id/pause`, `/resume`, `/stop` | `POLPO_GATEWAY_CAMPAIGN_CONTROL=1`, and `decidedBy: user` for `stop` |
| `POST /v1/campaigns/:id/prompt` (steer: a correction or a new priority) | `POLPO_GATEWAY_CAMPAIGN_CONTROL=1`; refused while the session is busy, like any prompt |
| `POST /v1/campaigns` (start a campaign from a repository's campaign file) | `POLPO_GATEWAY_CAMPAIGN_CONTROL=1`; it starts in `awaiting_definition`, so nothing runs until a `definition` decision is answered |

Every one of these is recorded in the ledger with channel
`gateway:<client>`. Answers through the PA count as weaker evidence than
answers you gave on the dashboard when earned autonomy (phase 4) weighs
them.

What a PA can never do: change a pin without a `definition` decision,
run a campaign in `bypass`, or decide a definition, a verdict or an
approval itself. It can carry your answer to any of them.

## 5. Security

- Gate commands come from a repository file, and polpo runs them. They
  run only after you approve the pinned campaign, as an argv without a
  shell, with the same privileges the agent already has.
- The agent can change gate scripts. It cannot change the pin, and every
  change is shown on the verdict.
- A campaign never runs in `bypass`.
- Ledger and exports pass through the secret filter; files are 0600.
- Only you can stop a campaign, approve a definition, accept a milestone
  or answer an approval: on the gateway that means an answer attested
  `decidedBy: user`, recorded with your words. No host setting changes
  that.
- Control through the gateway is off unless the host sets
  `POLPO_GATEWAY_CAMPAIGN_CONTROL=1`; reading needs only the gateway key.
- Webhooks are signed (HMAC-SHA256), go only to https or loopback, carry
  filtered text, and never block the campaign.
- Decisions close on the first answer and expire when the campaign moves
  on, so a delayed or duplicated message from a chat platform cannot
  decide something you did not see.

## 6. Phases

1. **Definition, ledger, gates, decisions, approvals.** Campaign file and
   pin, `CampaignStore`, binding to a session, `GateRunner` on demand
   (`/gate`), the ledger, export, pending decisions with their gateway
   routes (read, poll, answer, attestation), and tool approvals as
   decisions that wait for you. The `definition` decision is the first one
   every campaign needs, so a PA can direct a campaign from day one.
2. **Inner loop.** The driver, budgets, no-progress detection, verdict,
   question, budget and resume decisions, write-back after accept, the
   webhook, verdict cards on the phone.
3. **Advisor.** Drift flags and investigations through the mind's
   reasoner.
4. **Earned autonomy**, using the ledger as evidence.

**Dogfooding.** Phase 2 is built as the first campaign, directed by phase
1. polpo has good executable gates already (`npm test` and the end-to-end
scripts against a real server with a fake agent), and it would be steered
through a PA. Design problems surface on polpo's own work first, and the
ledger becomes the first steering record produced the way section 4.6
describes.

## 7. Decisions taken

1. **The campaign file is JSON.** No new dependency. It is drafted by the
   PA or the agent and approved as a readable rendering, so hand-writing
   JSON is rare.
2. **Resuming after desk work is your call.** A `resume` decision when the
   session goes idle; automatic resume is a per-campaign option, off by
   default.
3. **A PA decides nothing on its own by default.** `POLPO_CAMPAIGN_AGENT_MAY`
   starts empty and can only ever hold `question`, `budget` and `resume`,
   widened on evidence from the ledger.
4. **Approvals are in phase 1, and they wait.** A campaign approval is a
   decision the PA can carry but never take, and it does not expire after
   five minutes; the budget clock stops while it waits.
5. **Budgets are turns, time and repeated failures.** Cost is shown where
   the agent reports it, not enforced.

## 8. Phase 1 as built

### Starting a campaign

1. Put a campaign file in the repository (default `.polpo/campaign.json`,
   section 4.1). polpo checks it strictly: unknown keys, a gate given as a
   string instead of an argv list, or a pinned path outside the
   repository are errors, so a typo cannot quietly change what you approve.
2. Propose it, from any of:
   - the dashboard: `/campaign start [file]` in the chat of the session
     the campaign should hold (it then continues that session);
   - the gateway: `POST /v1/campaigns { cwd, file?, sessionId? }`, with
     `POLPO_GATEWAY_CAMPAIGN_CONTROL=1`; without `sessionId` polpo starts a
     new session when the campaign is approved.
3. Approve the `definition` decision. It shows the ladder as text, with
   the file's hash. On approval polpo pins the file and the pinned paths,
   takes or starts the session as `campaign:<id>`, keeping the permission
   mode it had at your desk, and sends the agent a briefing: the
   objective, the active milestone, how it is accepted, its gate, the
   constraints and `read_first`. The briefing says that polpo runs the
   gate itself and that the agent's own checks do not pass a milestone.

The campaign id is the file's `name`; a second campaign with the same name
is refused. Campaigns hold Claude sessions only for now: approvals and the
desk handback both rely on Claude's transcript and permission prompt.

### What runs, and when

- **Prompts** come from you: the dashboard's prompt box, or
  `POST /v1/campaigns/:id/prompt` through a PA. A prompt is refused while
  the agent is working. The inner loop that prompts on its own is phase 2.
- **Gates** run on demand: the Run gate button, `/gate [milestone]`, or
  `POST /v1/campaigns/:id/gate`. A gate is refused while the agent is
  working (it would test a tree being edited) and while another gate runs.
  The run records the commit, whether the tree had uncommitted changes and
  a hash of them, the exit code, the duration, the log's sha256 and its
  last 200 lines, the pinned paths changed since approval, and the model
  the session reported. Logs are kept in
  `~/.config/polpo/campaigns/<id>/gates/`.
- **A changed campaign file** is noticed when a turn ends, and before any
  prompt or gate: the campaign stops in `awaiting_definition` and a new
  `definition` decision lists what changed, milestone by milestone. A
  version you rejected is not asked about again; going back to the
  approved version leaves the campaign paused for you to resume.
- **Desk work**: a prompt typed in VSCode or a terminal while polpo holds
  the session hands it back at once and is recorded with channel `desk`.
  So is another holder taking the session (the dashboard, another gateway
  caller). The campaign is then `paused_desk`.
- **Resuming** after a pause, a handback or a polpo restart is the
  `resume` control (dashboard button, `/resume`,
  `POST /v1/campaigns/:id/resume`). The `resume` decision that polpo
  raises on its own is phase 2.
- **Stopping** supersedes every pending decision, denies a waiting
  approval and hands the session to the dashboard, where it continues as
  an ordinary session.

### Approvals that wait

When the agent of a campaign session asks for an approval, it becomes an
`approval` decision (`allow`/`deny`; `approve`/`reject` for a plan;
`answer`/`deny` for a question, the answer text going to every question)
on the dashboard, the phone and the gateway. Auto-approve is ignored on a
campaign session. The approval does not expire: the hub answers the
permission server `{ "retry": true }` every four minutes and the server
asks again with the same tool use id, so no HTTP request stays open for
hours and one approval stays one decision. Claude aborts an MCP call that
is silent for 30 minutes unless the server sets its own timeout, so polpo's
approval server is configured with a 7 day one. Outside campaigns an
approval is still denied after five minutes.

### The gateway, as built

The routes of section 4.10 exist except the webhook and the `diff` route
(phase 2, with verdicts); a `definition` decision lists its changes
instead. `GET /v1/campaigns/:id/decisions/:decisionId` returns one
decision, open or closed, and `POST /v1/campaigns/:id/gate` runs a gate.
An answer attested `decidedBy: "user"` must carry `relay.userMessage`, the
user's words (for a button tap, the button's text): the ledger records an
attestation with nothing to show as weaker than none. Answers from the
dashboard and from the phone are both recorded as channel `dashboard`:
they are the same page.

### Records

`polpo campaign list`, `polpo campaign verify <id>` (checks the hash
chain) and `polpo campaign export <id> [--out DIR]` read
`~/.config/polpo/campaigns/` directly; no server is needed.

## References

[1] G. M. Kurtzer, "Ginux: Building an Independent Kernel That Runs Linux
Userspace through Human-Directed Agentic Engineering", technical report,
October 2026. DOI [10.5281/zenodo.23682548](https://doi.org/10.5281/zenodo.23682548).
Source: [github.com/gmkurtzer/ginux](https://github.com/gmkurtzer/ginux).
