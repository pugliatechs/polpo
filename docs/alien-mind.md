# Alien Mind: Meta-Agent Coordination

> ⚠️ **Experimental — needs stabilization.** The Alien Mind ships in v1.2.0 as a fully functional but still-maturing feature. Planning quality, re-planning heuristics, and watcher tuning are all areas where the LLM-driven decisions can surprise you. Use it in environments where you can supervise the dashboard and abort if needed. The mind is opt-in (`POLPO_MIND=1`) precisely so it never interferes with the standard dashboard workflow. Treat outputs as drafts, watch for runaway spawns, and please report rough edges.

The Alien Mind is a meta-agent coordination layer inspired by the octopus's distributed brain. Individual AI agents (Claude, Codex, Gemini, Goose, Pi) are the "arms" with partial autonomy. The mind coordinates them: decomposes goals into tasks, assigns work to agents, handles dependencies, and monitors completion.

## Quick Start

Enable the mind by setting an environment variable:

```bash
POLPO_MIND=1 node bin/polpo.js server
```

The "Alien Mind" instance appears in the dashboard with a purple badge. Select it and type a goal to start coordinating agents.

## How It Works

1. **You send a goal** to the mind instance (e.g., "Refactor the auth module and update the tests")
2. **The mind plans** by asking Claude to decompose the goal into tasks with dependencies
3. **Each task spawns a fresh agent** via the shared `OneShotAgentRunner` (the same lifecycle the HTTP gateway uses for external callers)
4. **Parallel execution**: independent tasks fan out as parallel one-shot runs
5. **Sequential execution**: dependent tasks wait, then receive predecessor output as injected context
6. **Completion detection**: each runner.run() resolves when the agent goes idle; the coordinator picks up the captured output synchronously
7. **Agent terminates**: after each task the agent process is stopped and unregistered — no pool, no reuse
8. **Results reported**: progress and outcomes appear in the mind's conversation

## Architecture

The mind registers as a regular instance in InstanceManager (`agentType: 'mind'`). It reuses all existing infrastructure with zero changes to the core.

```
User (Phone Dashboard)
    |
    v
Alien Mind (instance in dashboard)
    |-- WorldModel: observes all agents via InstanceManager events
    |-- Reasoner: spawns Claude Code for goal decomposition + re-planning
    |-- Coordinator: goal lifecycle + dependency graph + inter-arm context
    |-- OneShotAgentRunner: shared spawn/timeout/teardown primitive
    |     (also used by the HTTP gateway — same hardening for both)
    |-- Memory: long-term JSONL of past goals, surfaced into planning context
    |-- GoalStore: durable snapshot of in-flight goals (recovery after restart)
    |-- Watcher: passive monitoring + policy-gated autonomous action
    |
    +-- Arm 1 (Claude, /project-backend)  -- Task A    (spawned, runs, terminates)
    +-- Arm 2 (Goose,  /project-infra)    -- Task B    (spawned in parallel)
    +-- Arm 3 (Codex,  /project-frontend) -- Task C    (spawned after A, gets A's output)
```

### Shared one-shot lifecycle

The mind and the gateway are two callers of the **same** primitive — `OneShotAgentRunner` ([src/agent/one-shot-runner.js](../src/agent/one-shot-runner.js)). The runner owns:

- spawning the agent process via the agent factory
- waiting for the WebSocket handshake (5 s deadline)
- arming a per-run timeout *before* sending the prompt (so a hung start still trips)
- sending the prompt with optional pre-staged attachments
- routing the `instance:status` / `instance:message` / `instance:approval` events that come back
- aborting and stopping the agent at terminal state (success, timeout, approval-required, external cancel)
- unregistering the instance and resolving the run with a captured result snapshot

Higher-level callers (gateway, mind) bring only their own *policy*: rate limits + attachments + artifacts + SSE fanout for the gateway; decomposition + replanning + dependency graph + memory for the mind. Bug fixes to spawn/timeout/teardown land in one place and benefit both call sites.

A mind-spawned arm is tagged `source: 'mind:<goalId-tail>'` on the instance, distinguishing it from gateway-spawned arms (`source: 'gateway:<client>'`) and user-started ones (`source: null`). The gateway's session-discovery endpoints accept `source=mind` as a filter.

## Interactive Mode (default for chat-submitted goals)

Goals submitted via the mind's chat are **interactive by default**. The mind plans, posts a plan preview, and **waits for you to approve** before dispatching arms. If an arm gets stuck after the replan budget is exhausted (`MAX_REPLANS = 2`), the mind **escalates to chat** instead of permanently abandoning the task — you decide whether to retry with guidance, skip the task, or abandon the whole goal.

Gateway-submitted goals (`POST /v1/goals`) always run **auto-dispatch** (legacy fire-and-forget) because there's no human in the loop on the API. To submit a chat goal in the autonomous mode, prefix with `/auto ` or set `POLPO_MIND_AUTO_DISPATCH=1`.

### Approval round-trip

```
You:    Refactor the auth module and update its tests.

Mind:   Plan ready (3 tasks):
          1. Audit current auth module call sites
          2. Rewrite auth module
          3. Update tests against the new module

        Reply:
          /approve            — dispatch the plan as-is
          /tweak <feedback>   — revise the plan with your feedback
          /abandon            — cancel this goal

You:    /tweak start with task 3 (regression tests first)

Mind:   Revising plan with your feedback…
        Plan ready (3 tasks):
          1. Snapshot current test behaviour
          2. Rewrite auth module
          3. Update tests against the new module
        …(reply with /approve, /tweak, or /abandon)

You:    /approve

Mind:   Plan approved. Dispatching 3 arms…
```

### Escalation round-trip

```
Mind:   🛑 Arm stuck on: Rewrite auth module

        Reason: needs the legacy session library installed before refactoring

        Last output (truncated):
          I can't proceed because the existing module imports session-lib@2.x
          which isn't installed. Please install session-lib@2.x or point me at
          the new replacement.

        Reply:
          /retry <hint>   — re-run this arm with your guidance
          /skip           — abandon this arm and cascade-fail its dependents
          /abandon        — cancel the whole goal

You:    /retry use the new oauth-session module at lib/oauth-session.ts instead

Mind:   Retrying with your guidance: Rewrite auth module
```

## Commands

Type these in the mind's conversation:

| Command | Description |
|---------|-------------|
| Any text | Submitted as a goal. Plans + waits for `/approve` (interactive mode). |
| `/auto <text>` | Submit a goal in auto-dispatch mode — no approval gate, escalations fall through to permanent failure (legacy behaviour). |
| `/approve [goalId]` | Approve the most-recent plan preview and dispatch arms. Optional explicit goal id when multiple plans are pending. |
| `/tweak <feedback>` | Revise the awaiting-approval plan; reasoner re-runs with the original prompt + your feedback. |
| `/retry [hint]` | Resume the most-recent escalated arm with optional user guidance. Resets the replan budget. |
| `/skip` | Abandon the most-recent escalated arm and cascade-fail its dependents. |
| `/abandon` | Cancel either the awaiting-approval goal or the goal owning the escalated arm. |
| `/agents` | Show current state of all agents |
| `/goals` | List active goals with task status |
| `/cancel` | Cancel all active goals (running, planning, or awaiting approval) |

### Bypassing interactive mode

For autonomous use cases (background CI, batch runs, etc.) where you don't want to approve every plan:

```bash
# Per-process default — every chat goal auto-dispatches without preview.
POLPO_MIND_AUTO_DISPATCH=1 polpo server

# Per-goal override — single goal bypasses both approval AND escalation.
/auto Refactor the auth module
```

Auto-dispatch goals do NOT escalate on `MAX_REPLANS` — they fall through to permanent task failure, same as v1.2.1 and earlier.

## Task Dependencies

The mind supports DAG-based task plans. Examples:

**Parallel**: tasks with no dependencies run simultaneously
```
Goal: "Lint the code and run tests"
  Task 1: Run linting       (no deps)
  Task 2: Run test suite    (no deps)
  -> Both run in parallel on separate agents
```

**Sequential**: dependent tasks wait
```
Goal: "Refactor auth then update tests"
  Task 1: Refactor auth middleware    (no deps)
  Task 2: Update auth tests          (depends on Task 1)
  -> Task 2 waits for Task 1 to complete
```

**Diamond**: mix of parallel and sequential
```
Goal: "Build, test, and deploy"
  Task 1: Build the project           (no deps)
  Task 2: Run unit tests              (depends on 1)
  Task 3: Run integration tests       (depends on 1)
  Task 4: Deploy to staging           (depends on 2 and 3)
  -> 2 and 3 run in parallel after 1, then 4 runs
```

## Task dispatch — one-shot, every time

There is no pool and no idle-agent reuse. Every task gets a fresh agent process, dispatched through `OneShotAgentRunner.run(...)`:

```
coordinator._assignTask(task)
   └─ runner.run({
        agentType, cwd, prompt: <predecessor-context> + task.prompt,
        name: "Mind arm: <task description>",
        source: "mind:<goalId-tail>",
        timeoutMs: <policy.taskTimeoutMs>,
        onSpawn, onChunk, onApproval, onTerminal
      })
```

Why one-shot:

- **Eliminates an entire class of bugs** that the old pool reuse path had: agents from a previous task carrying state, idle-detection races, "is this arm available?" guards, etc.
- **Every "thought" is auditable**: each task is an isolated agent invocation you can replay or attribute.
- **Failed agents don't poison subsequent attempts**: a stuck or misbehaving arm dies at the end of its run and the next task starts clean.
- **Lifecycle hardening is shared**: the timeout/approval/cleanup logic the gateway has battle-tested for months also protects every mind arm.

Trade-off: no cross-prompt agent memory. The coordinator addresses this by injecting predecessor task output into successor prompts (see "Inter-Arm Communication" below), and the world-model + memory modules carry state across the goal's lifetime.

Arms spawned by the mind get `permissionMode: 'bypass'` when the policy's `autoApproveSpawned: true` (the default for `balanced` and `autonomous`). If an approval request slips through anyway, the runner fails the task immediately with `approval_required` (fail-closed) — the failure path then asks the reasoner to retry/split/abandon.

## WorldModel

The WorldModel mirrors all agent states in real-time by subscribing to InstanceManager events:

- `instance:registered` -- new agent appears
- `instance:disconnected` -- agent goes offline
- `instance:status` -- agent goes busy/idle/waiting
- `instance:message` -- conversation updates
- `instance:approval` -- approval requests

It provides:
- `getSnapshot()` -- all agents with status, project, cwd, type
- `getIdleAgents()` -- agents ready to accept work
- `getAgentsByProject(name)` -- filter by project
- `getSummary()` -- human-readable text for the LLM reasoner

And emits:
- `agent:idle` -- when any agent goes idle
- `agent:busy` -- when any agent goes busy
- `all:idle` -- when all agents are idle (all work done)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `POLPO_MIND` | `0` | Set to `1` to enable the mind |
| `POLPO_MIND_MODEL` | (agent default) | Model for the reasoning agent |
| `POLPO_MIND_POLICY` | `balanced` | Autonomy level (future) |

## Inter-Arm Communication

Dependent tasks share findings: when task B depends on task A, the mind brokers context between them. Before B starts, the mind extracts the trailing assistant text from A's conversation and prepends it to B's prompt as a `<previous_task_results>` XML block. This means arms can produce findings their dependents need without the user staging files manually.

```
Task A (no deps):  "List the failing tests and summarize their error messages."
Task B (deps=[A]): "Fix each test listed above."
   B's prompt automatically includes A's last assistant message
```

Truncation limits keep the combined prompt bounded; each predecessor's output is capped before being inlined.

## Re-Planning on Failure

When a task fails, the coordinator doesn't immediately give up. It calls the reasoner with the failure reason, the partial output, and the original plan, and asks for one of three actions:

| Action | Behaviour |
|--------|-----------|
| `retry` | Re-run the same task with the same prompt, on a fresh arm. Useful for transient errors. |
| `split` | Replace the failed task with a sequence of smaller sub-tasks. Useful when the original was too large. Dependents are re-pointed to the last sub-task. |
| `abandon` | Mark failed and let the failure cascade through `dependsOn`. Used when retry/split won't help. |

Each task is allowed `MAX_REPLANS = 2` re-plans before it's permanently abandoned. This prevents infinite loops on hopeless tasks while giving real failures a chance to recover.

## Long-Term Memory

The mind keeps a JSONL log of completed goals at `~/.config/polpo/mind-memory.jsonl` (mode 0o600). Each entry records:

- The goal prompt and outcome (`completed` / `failed` / `partial`)
- Task summaries (one line per task with status + reasoner's evaluation)
- Duration

Before planning a new goal, the mind searches memory for the 5 most-relevant past goals using a Jaccard-similarity keyword match (no embeddings, no new dependencies) and injects them into the planning context. This biases the reasoner toward approaches that have worked before and away from ones that have failed.

Memory bounds:
- Each entry is capped at 10 KB
- Search returns at most 50 results, ranked by overlap
- Malformed lines are skipped silently on load

## In-Flight Goal Persistence

Arms are spawned subprocesses — they cannot survive a polpo restart. But the mind no longer silently loses active goals when polpo is killed and restarted.

`GoalStore` snapshots every active goal to `~/.config/polpo/mind-active-goals.json` (mode 0o600, atomic rewrite) on every state transition: planning → running → task complete → goal complete. On startup, the mind loads the store, marks any leftover goals as **interrupted**, writes a summary to long-term memory, and reports them to the user in the mind's conversation:

```
Recovered 1 interrupted goal from before restart:
- Refactor the auth module (2/4 tasks completed)

Arms could not be resumed; resubmit if you want to retry.
```

The store is then cleared, so a clean shutdown after this report is well-defined.

## Failure Handling

- **Task timeout**: 5–15 minutes per task depending on policy, enforced by the runner. Timed-out tasks go through the re-plan flow.
- **Spawn failure**: if the runner can't bring the agent up (bad cwd, WS handshake timeout, etc.), the run resolves with `status: 'failed'` and the coordinator routes that into the re-plan flow.
- **Approval requested**: the runner fails closed with `approval_required` (no human in the loop), then re-plan runs.
- **Dependency failure**: if a task abandons, all transitively-dependent tasks cascade-fail.
- **Planning failure**: if the reasoner can't produce a plan, the goal fails with the reasoner's error.
- **External cancel** (`cancelGoal`, watcher-driven `failAgentTask`): the runner aborts the arm; the coordinator marks the task failed with no replan (cancellation is an explicit decision).
- **Server restart**: all in-flight goals reported as interrupted on next start (see above).

## File Structure

```
src/agent/
  one-shot-runner.js # Shared spawn → prompt → terminate primitive (also
                     #   used by the HTTP gateway). Owns the lifecycle:
                     #   WS handshake, per-run timeout, event routing,
                     #   approval fail-closed, agent stop + unregister.

src/mind/
  index.js           # Module entry, createMind(), instance registration,
                     #   command handling, runner construction
  world-model.js     # Real-time agent state mirror via InstanceManager events
  coordinator.js     # Goal/task lifecycle, dispatch via runner.run(),
                     #   dependency graph, inter-arm context, re-plan,
                     #   memory + goal-store wiring
  reasoner.js        # LLM planning + evaluate + replan, via Claude Code process
  watcher.js         # Passive monitoring + policy-gated auto-cancel of stuck tasks
  policies.js        # Configurable autonomy levels (conservative/balanced/autonomous)
  memory.js          # Long-term goal memory (JSONL, Jaccard search)
  goal-store.js      # In-flight goal persistence (JSON, atomic rewrite)
```

> **Note on dead modules**: earlier versions of polpo had `src/mind/agent-pool.js` (idle-arm reuse + spawn cap) and `src/mind/task-runner.js` (DAG executor that was never wired in). Both were removed when the mind switched to one-shot dispatch through `OneShotAgentRunner`. If you're following an older diff or migration guide that references them, the runner replaces both.

## Autonomous Monitoring (Watcher)

The watcher runs every 30 seconds and acts in two stages:

**Stage 1 — Alert (all policies)**
- **Stuck agents**: busy for longer than `stuckThreshold` without status change → posts a warning in the mind's chat
- **Stale approvals**: agents waiting for approval → posts a reminder
- **Alert deduplication**: each issue is reported once, cleared when resolved, re-reported if it recurs

**Stage 2 — Act (`autoActOnStuck` policies)**
- If a stuck agent is running a coordinator-owned task AND its busy time exceeds `stuckThreshold × stuckActionMultiplier`, the watcher calls `coordinator.failAgentTask(...)`. Under the hood that marks the task failed (entering the re-plan path) and then calls `runner.cancel(agentId)`, which aborts the arm and stops the agent process. User sessions and gateway-spawned arms are untouched — only mind-owned tasks (`source: 'mind:...'`) are auto-cancelled.

The watcher emits a single "🛑 Auto-cancelled" message in the mind's chat when it acts, so the user always sees what happened.

## Policies

Three autonomy levels control the mind's behavior:

| Policy | Auto-approve spawned | Max concurrent tasks | Task timeout | Stuck threshold | Auto-act on stuck | Action multiplier |
|--------|---------------------|----------------------|--------------|-----------------|-------------------|-------------------|
| `conservative`        | No  | 2 | 5 min  | 10 min | No  | — |
| `balanced` (default)  | Yes | 4 | 10 min | 15 min | Yes | 2× (act at 30 min) |
| `autonomous`          | Yes | 8 | 15 min | 20 min | Yes | 1× (act at 20 min) |

The `maxSpawnedAgents` field in earlier versions was a pool ceiling; with one-shot dispatch every task spawns a fresh agent so the meaningful cap is `maxConcurrentTasks`. The runner enforces concurrency at the call site.

Set via environment variable:
```bash
POLPO_MIND_POLICY=conservative POLPO_MIND=1 node bin/polpo.js server
```

## Security

- **Opt-in**: only loads when `POLPO_MIND=1` is set
- **No new dependencies**: pure Node.js, uses existing agent infrastructure
- **Process isolation**: the reasoner's Claude process uses `--dangerously-skip-permissions` but only generates JSON plans, never touches user code
- **Per-task agent isolation**: each arm is spawned fresh and terminated when the task ends — no cross-task state in agent processes
- **Per-run hardening**: each arm inherits the runner's timeout, approval fail-closed, and clean teardown — the same protections gateway callers get
- **Source tag**: every arm registers as `source: 'mind:<goalId-tail>'` so operators can audit which goal owned which arm
- **No secrets handling**: the mind doesn't manage tokens or credentials
