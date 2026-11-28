# Departments: running a small company through polpo

**Status:** design. Nothing in this document is built yet. It builds on
campaigns ([campaigns.md](campaigns.md)), on driven sessions and the
approval relay ([gateway.md](gateway.md#driving-a-session)) and on
browser sessions ([gateway.md](gateway.md#browser-sessions)).

A solopreneur runs a company the bootstrap way: no staff yet, a few
departments (marketing, sales, product, finance, later HR), and one
person who decides. They talk to an assistant in a chat app (a Telegram
bot, OpenClaw or anything similar). The assistant hands the work to
polpo, polpo runs one coding-agent session per department on the
owner's machine, and every decision with an effect outside the machine
comes back to the owner through the assistant.

Later the company hires. Each person runs polpo on their own PC, the
departments move to the people who now own them, and decisions go to
whoever has the authority for them (section 6).

polpo stays general. It gains department profiles, an operations guard,
a push channel and a few routes. It gains no marketing, sales or
accounting features: the company lives in folders and in the
assistant's instructions.

## 1. The shape

```
        owner (chat app)
              |
          assistant            conversation, memory, schedules,
              |                turns a goal into requests
              |  gateway (HTTP, Bearer key)
              v
            polpo              department sessions, operations guard,
         /    |    \           decisions back to the owner, ledger
  marketing  sales  product    one lasting session each, in its folder
       \      |      /
       company repository      handbook, journals, decision records
```

- **The assistant** is the chief of staff. It holds the conversation
  with the owner, remembers context, runs the recurring routines (the
  weekly newsletter, the monthly bookkeeping import), and turns "launch
  the spring offer" into requests to departments. Scheduling stays
  here: polpo has no scheduler and does not get one.
- **polpo** does the work and holds the line. It runs each department's
  session, decides on every operation the agent attempts, brings each
  decision to the owner and records who decided what.
- **The company** is a repository of folders: a handbook at the top
  (offer, pricing, voice, constraints), one folder per department with
  its own instructions file, skills and journal.

```
company/
  HANDBOOK.md
  marketing/   CLAUDE.md  JOURNAL.md  decisions/  drafts/
  sales/       CLAUDE.md  JOURNAL.md  decisions/  leads/
  product/     (code repositories; campaigns fit here as they are)
  finance/     CLAUDE.md  JOURNAL.md  decisions/  exports/  invoices/
```

## 2. What polpo already has

| Need | Already there |
|---|---|
| Start a session in a folder | `POST /v1/instances` (agent, folder, model, mode, title, first prompt) |
| Keep talking to it | `POST /v1/instances/:id/prompt`, `GET /v1/instances/:id/conversation` |
| Bring it back after it stopped | `POST /v1/sessions/:id/resume`, in the folder its transcript records |
| Put approvals to the owner | `POLPO_GATEWAY_APPROVALS=1`, answers attested `decidedBy: user` with the owner's words; questions too |
| Long initiatives | campaigns: milestones, gates, verdicts, ledger |
| Websites with no API | browser sessions: site list, free reading and filling, plan approval with a screenshot |
| Tools per folder | MCP servers configured per folder |
| One writer per session | sessions held by `gateway:<client>`, desk work hands them back |

What is missing is in sections 3 to 5.

## 3. Departments

### 3.1 Profiles

A department is a profile in the host's configuration, never something
the caller describes. The file is `~/.config/polpo/departments.json`,
checked like `browser-sites.json`: a regular file, owned by the user
polpo runs as, readable by nobody else. polpo refuses to start with a
profile it cannot validate.

```json
{
  "version": 1,
  "departments": {
    "marketing": {
      "cwd": "/home/owner/company/marketing",
      "agentType": "claude",
      "model": "...",
      "permissionMode": "default",
      "mcpServers": {
        "scheduler": { "type": "http", "url": "https://mcp.scheduler.example/mcp" }
      },
      "browser": { "sites": ["linkedin.com"] },
      "policy": "marketing",
      "budgets": { "turnsPerDay": 200 }
    }
  },
  "policies": {
    "marketing": { "rules": [ "...section 4.2..." ] }
  }
}
```

- **`cwd`** is fixed by the profile. The gateway names a department,
  never a folder, so the assistant cannot widen a department's reach by
  choosing another directory. Today `checkCwd` only checks that the
  folder exists.
- **`agentType`** is `claude` only, until another agent has a place
  where polpo can decide on its operations (section 5).
- **`permissionMode`** is `default` or `plan`. `auto` and `bypass` are
  refused at load: a session that lives for weeks must never run
  operations polpo did not see.
- **`mcpServers`** are the only MCP servers the session gets. polpo
  writes them into the session's MCP config and passes
  `--strict-mcp-config`, so the owner's own servers never load into a
  department.
- **`browser`** works as browser sessions do today.
- **`policy`** names the operations guard rules (section 4).

The profile is applied every time polpo starts the department's
session: on the first start, on resume and on the change of session
(3.3). That closes today's gap where a resumed browser session comes
back without `--chrome`, its guard and `--strict-mcp-config`.

### 3.2 One lasting session per department

A department is one session the assistant keeps talking to, not a
series of one-shot tasks. The session's history is its working memory.

polpo keeps the binding from department to its current session in
`~/.config/polpo/departments/<name>/state.json` (mode 0600). The
assistant says "marketing", never a session id, so ids going stale after
a restart, a resume or a change of session are polpo's problem only.

```
POST /v1/departments/:name/prompt     { "text": "...", "promptId": "..." }
GET  /v1/departments/:name            profile summary, session, status, queue, pending decision
GET  /v1/departments/:name/conversation?since=
POST /v1/departments/:name/approval   as POST /v1/instances/:id/approval
POST /v1/departments/:name/abort
```

- **Starting is implicit.** A prompt to a department with no live
  session resumes the bound one, or starts the first one, with the
  profile applied.
- **One writer.** polpo holds the session as `department:<name>`. The
  owner can still take it over at the dashboard or the desk; the
  department is then `paused_desk` until it is idle again, as a
  campaign is.

### 3.3 The journal and the change of session

History does not last forever. Long sessions are compacted by the agent
CLI and compaction loses detail, so the conversation cannot be the
record. Following the campaigns rule that plans live outside the
conversation:

- Each department keeps a journal in its folder: `JOURNAL.md` for open
  threads and facts (customers, prices agreed, what was sent), and
  `decisions/` for decision records. The profile's instructions tell the
  agent to bring them up to date at the end of every piece of work.
- **Change of session.** When a session grows past a threshold, or on
  request, polpo asks it to update the journal, waits for it to go idle,
  starts a fresh session told to read the handbook and the journal
  first, and moves the binding. The old session stays in the catalogue,
  read only.
- The ledger records every change of session, so "what did marketing
  know on the 3rd" has an answer.

How polpo measures a session's size is to be verified (section 9).

### 3.4 Prompts while the department is busy

Today a prompt to a busy session is refused. Departments get a queue:

- Bounded (default 20, host setting), first in, first out, each prompt
  with the caller's `promptId` so a retried request is not queued twice.
- Delivered one at a time when the session goes idle.
- The caller can list and cancel queued prompts.
- A queued prompt is never merged with another: each is its own turn, so
  each reply answers one request.

### 3.5 Events

The flow goes both ways. A department has to reach the owner when it
finishes, asks something or needs a decision, without the assistant
polling.

Events, each with a sequence number:

| Event | Carries |
|---|---|
| `reply` | the department went idle; its last message (through the secret filter), the `promptId` it answered |
| `approval_pending` | what `pendingApproval` carries today |
| `plan_pending` | a plan to approve (section 4.3) |
| `question` | the agent asked the owner something |
| `queue_delivered` | a queued prompt went in |
| `session_changed` | the binding moved to a new session |
| `error` | the session ended with an error, or could not start |

Two transports:

- `GET /v1/departments/events?since=<seq>` as a server-sent event
  stream; `since` catches up after a disconnect.
- A signed webhook (HMAC-SHA256, https or loopback only, filtered text,
  never blocking the department): the one campaigns phase 2 builds, with
  this event format (section 7).

Both are built so the same events can later travel over a connection
polpo opens itself (section 6).

### 3.6 Files back to the assistant

Departments produce files: a PDF offer, a CSV of leads, an invoice
draft. Each department gets an outbox folder with the rules of the
session outbox ([outbox.md](outbox.md)): regular files only, names in
`[A-Za-z0-9._-]`, size and count limits, a sealed copy taken when the
session goes idle.

```
GET /v1/departments/:name/files
GET /v1/departments/:name/files/:fileId
```

The `reply` event lists the files that came with it.

## 4. The operations guard

The browser guard is the first instance of a general rule: polpo decides
on every operation a department's agent attempts, and the owner approves
anything with an effect outside the department.

### 4.1 Classes and levels

| Class | Examples | Default level |
|---|---|---|
| Read | read files in the department folder, search them | free |
| Local write | edit files in the department folder (journal, drafts) | free |
| Outside the folder | read or write anywhere else | deny |
| Web reading | fetch a page, search the web | deny unless the profile lists domains |
| External effect | send an email, post, update the CRM, create an invoice, `git push`, submit a form | plan, or every action |
| Never | payments, credentials, polpo's own configuration, another department's folder | deny at any level |

Levels are the browser guard's: `free` (allowed and recorded), `plan`
(allowed under an approved plan, section 4.3), `every` (each operation
put to the owner), `deny`.

A tool the policy does not name is `every`. A tool polpo cannot read
the input of is `deny`.

### 4.2 Policy rules

A policy is a list of rules, first match wins:

```json
{
  "rules": [
    { "tool": "Read",  "within": "cwd", "level": "free" },
    { "tool": "Edit",  "within": "cwd", "level": "free" },
    { "tool": "Write", "within": "cwd", "level": "free" },
    { "tool": "WebFetch", "domains": ["scheduler.example"], "level": "free" },
    { "tool": "mcp__scheduler__create_draft", "level": "free" },
    { "tool": "mcp__scheduler__publish", "level": "plan",
      "match": ["channel", "text"] },
    { "server": "scheduler", "level": "every" }
  ]
}
```

- `tool` matches one tool by exact name; `server` matches every tool of
  one MCP server. No wildcards beyond that.
- `within: "cwd"` checks the resolved path (symlinks followed) is inside
  the department folder.
- `match` names the input fields a plan must fix (section 4.3).
- The never class is not in the file: polpo applies it before any rule,
  and no rule can allow it.

### 4.3 Plans and grants

The browser grant is one site for a few minutes, because a page is hard
to describe ahead of time. Most operations can be described exactly.

- The agent calls `polpo_request_plan` with a purpose and a list of
  operations: tool, and the values of the fields the rule's `match`
  names (recipient, channel, amount, the text).
- polpo puts the plan to the owner as one decision: each operation in
  plain words, with the full text where there is one.
- An approved plan is a grant: each listed operation can run once, with
  exactly those field values (compared on the canonical JSON of the
  `match` fields), within a time limit (default 30 minutes, host
  setting). Anything not on the list goes to the owner.
- Browser plans keep their time window, where exact matching is
  impossible.
- A rejected or expired plan grants nothing; the agent is told why.

This generalizes `polpo_request_browser_grant`; the browser becomes one
kind of plan.

### 4.4 The shell

`Bash` can do anything: `curl` sends an email, `git` pushes. polpo does
not try to classify shell commands.

- Departments get no shell by default. Marketing, sales, finance and HR
  do not need one.
- A profile that needs one (product) lists exact commands, as campaign
  gates do: `{ "tool": "Bash", "commands": ["make test", "make lint"],
  "level": "free" }`. The match is on the whole command string, with no
  shell parsing. Every other command is `every`.
- A department's real effects go through MCP tools polpo can see, never
  through a script.

### 4.5 Where it is enforced

The browser work settled the mechanism (see
[security.md](security.md)):

- polpo injects `permissions.ask` rules with `--settings` for every tool
  the session has, so every call reaches polpo's permission prompt in
  every mode, and a project's own settings cannot remove them. polpo
  answers `allow` for free operations; the extra round trip is local.
- polpo decides on each item of a batch tool, never on the outer call
  only. A batch item that is itself a batch, or a tool polpo does not
  know, is denied.
- `disableBypassPermissionsMode` is set, and the mode is `default` or
  `plan`.
- The policy lives in the host's configuration, outside every department
  folder, and the agent cannot edit it.

What is verified today and what is not is listed in section 9.

### 4.6 Web reading

Reading the web is not harmless: a page can carry instructions that try
to leak what the agent knows, for example by building a URL with data in
it. Web reading is off unless the profile lists domains, and search is
a separate rule.

## 5. Preconditions

These come before any department runs.

- **No self-approval.** Today the permission server's MCP config
  (`<tmpdir>/polpo-mcp-<instance>.json`, mode 0600) holds the agent
  token, and the agent runs as the same user, so a session allowed to
  read files outside its folder or to run a shell can read it and call
  `/api/instances/:id/approve` itself. The fix: the permission server
  gets a token scoped to its own instance that opens only
  `/api/permission-request` and the plan routes, and the full agent
  token is never written where an agent can read it.
- **Never `auto`, never `bypass`** for a department (3.1).
- **Claude only** until another agent type has a place where polpo
  decides on its operations. Codex, Gemini, OpenCode, Pi and Goose take
  no permission mode from polpo today.

## 6. Growing to a team

When the company hires, each person runs polpo on their own PC. polpo
keeps one owner per machine: that person's sign-ins, files and
approvals. That is simpler and safer than turning polpo into a
multi-user server.

### 6.1 Each polpo stays in charge of its machine

- **polpo instances never talk to each other directly.** No mesh.
- **Each polpo connects out to a small company hub.** No PC opens a
  port; a laptop on hotel Wi-Fi works as one in the office.
- **The hub routes and records, and has no authority.** It can ask a
  polpo to prompt, start or resume a department. It cannot approve
  anything or loosen a policy. Each polpo enforces its own guard. A
  compromised hub gains an attacker requests, not decisions.

### 6.2 Approvals name a person and are signed

`decidedBy: user` takes the assistant's word, which is enough with one
person. In a team:

- An approval names a principal, and that principal must hold the
  authority for the action in the policy: the marketing lead approves a
  post, the owner approves a contract or a spend above a limit.
- The approval is signed by the approver's own device (their polpo, or
  their phone paired with it). The hub carries the signed answer; the
  polpo doing the work checks it. The hub's or an assistant's word alone
  never counts.
- Some operations need two approvers; the policy says which.

### 6.3 Policy comes in two layers

- The owner signs a company policy; each polpo pulls it from the hub.
  No payments by agents, what needs the owner, data rules for HR.
- Each person can tighten their local policy, never loosen the company
  one.

### 6.4 Departments outlive their sessions and their people

- A department's state (journal, decisions, campaign files) lives in the
  company repository, not on a PC.
- A session is a replaceable worker on whichever machine runs the
  department.
- Moving marketing to a new hire's machine moves the profile and the
  binding; a fresh session starts from the journal (3.3).

### 6.5 Departments without a person

Laptops sleep. Departments that must always answer (a support inbox,
bookkeeping imports) run on a polpo on a company server whose owner is a
role, with its approvals routed to the people responsible.

### 6.6 Records and data

- Each polpo keeps its ledger and sends a signed, append-only copy to
  the hub: one audit trail the hub cannot rewrite.
- HR data stays on HR's machine and in HR's repository. The hub carries
  requests and decisions, not documents, unless the company policy says
  otherwise.
- With employees, agents run on business plans of the agent providers,
  for their terms and for data handling.

### 6.7 What the single-machine work must already respect

Three choices are cheap now and expensive later:

1. **A principal, not "user".** Attestations and ledger entries record a
   principal and a role. On one machine there is one principal, the
   owner, but the format has room for more.
2. **Policies are data with an origin.** The policy format is layered
   (company, local) and has room for a signature, even while only the
   local layer exists.
3. **Events can travel outbound.** The department events (3.5) use a
   format that can later go over a connection polpo opens to the hub.

## 7. Phases

Departments build on campaigns rather than beside them, so campaigns
phase 2 comes first. Its webhook, its verdict and resume decisions and
its write-back after an accepted milestone are the same mechanisms a
department needs (events, decisions brought to the owner, the journal).

1. **Campaigns phase 2** ([campaigns.md](campaigns.md#6-phases)), built
   as the first campaign as planned, with four additions:
   - **Milestones without a gate**, accepted by the owner's verdict
     alone, offered when the agent says the milestone is done or when
     the owner asks for it. They make campaigns fit work that is not
     code (a launch, a lead list, a set of invoices).
   - **The webhook uses the event format of section 3.5**, so
     departments reuse it instead of adding a second one.
   - **Decisions and ledger entries record a principal** and a role
     (section 6.7), not just `user`.
   - **A campaign runs in its own session**, in the folder it works in,
     so a department's main session and a campaign never hold the same
     session.
2. **Preconditions.** The scoped permission token (section 5). The CLI
   checks of section 9, with logs kept.
3. **Operations guard** for every driven session, department, campaign
   or neither: the browser guard generalized, the policy format (layered,
   with an origin, section 6.7), plans and grants, the shell rule. The
   browser becomes one kind of plan.
4. **Departments:** profiles, the binding, the profile applied on every
   start and resume, the queue, events (over the campaigns webhook and a
   stream), files.
5. **Long life:** the journal convention and the change of session.
6. **Team:** the hub, outbound connection, signed approvals, the two
   policy layers, moving a department between machines.

Phases 1 to 5 are for one owner on one machine. Phase 6 starts when a
second person exists. Phase 2 can start alongside phase 1: the
self-approval fix matters to campaigns too.

## 8. Decisions taken

1. **Departments are lasting sessions, reused**, not one-shot tasks: the
   flow goes both ways and a session's history is its working memory.
2. **The guard covers every operation**, not just the browser.
3. **Scheduling stays in the assistant.**
4. **polpo stays general**: no department-specific features; the company
   is configuration and folders.
5. **Agents never move money and never type credentials**, at any level
   and in any policy.
6. **A team means one polpo per person and a hub without authority.**
7. **Campaigns phase 2 comes first**, with milestones without a gate,
   the shared event format, a principal on every decision and a session
   of its own (section 7).

## 9. To verify before building

Checked with real CLI runs so far: in `auto` mode Claude in Chrome tools
skip the permission prompt tool; `permissions.ask` rules injected with
`--settings` send them to it in every mode, and project settings do not
override that; `--disallowedTools` does not stop a tool run as an item
of `browser_batch`; `--strict-mcp-config` keeps Claude in Chrome and
drops the user's MCP servers.

Not checked yet:

- Whether `permissions.ask` rules hold the same way, in every mode, for
  `Read`, `Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch` and tools of
  other MCP servers, and whether one rule can cover every tool.
- Whether operations of subagents (the `Task` tool) reach the parent's
  permission prompt tool. If they do not, departments get no `Task`.
- How polpo can read how large a session has grown from the agent's
  output, for the change of session.
- Whether `--strict-mcp-config` with a generated config keeps exactly
  the profile's servers and nothing else.

## 10. Open questions

- **What a department knows about its campaigns.** A campaign runs in
  its own session (section 7), so the department's main session does not
  see it. Whether the department is told of a campaign's verdicts, or
  only the owner, is open.
- **Budgets.** Campaign budgets count turns and hours. A department may
  want cost, which polpo cannot see for subscription plans.
- **Free operations in the ledger.** Every operation is recorded, or
  only a daily summary of free ones.
