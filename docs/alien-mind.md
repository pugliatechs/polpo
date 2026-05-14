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
3. **Tasks are assigned** to idle agents that match the target project/cwd
4. **Parallel execution**: independent tasks run simultaneously on different agents
5. **Sequential execution**: dependent tasks wait for their predecessors to complete
6. **Completion detection**: the mind watches agent status changes (busy -> idle)
7. **Results reported**: progress and outcomes appear in the mind's conversation

## Architecture

The mind registers as a regular instance in InstanceManager (`agentType: 'mind'`). It reuses all existing infrastructure with zero changes to the core.

```
User (Phone Dashboard)
    |
    v
Alien Mind (instance in dashboard)
    |-- WorldModel: observes all agents via InstanceManager events
    |-- Reasoner: spawns Claude Code for goal decomposition + re-planning
    |-- Coordinator: manages goal/task lifecycle + inter-arm context sharing
    |-- TaskRunner: DAG executor for parallel + sequential tasks
    |-- AgentPool: reuses idle arms or spawns new ones
    |-- Memory: long-term JSONL of past goals, surfaced into planning context
    |-- GoalStore: durable snapshot of in-flight goals (recovery after restart)
    |-- Watcher: passive monitoring + policy-gated autonomous action
    |
    +-- Arm 1 (Claude, /project-backend)  -- Task A
    +-- Arm 2 (Goose,  /project-infra)    -- Task B
    +-- Arm 3 (Codex,  /project-frontend) -- Task C (depends on A, gets A's output)
```

## Commands

Type these in the mind's conversation:

| Command | Description |
|---------|-------------|
| Any text | Submitted as a goal for planning and execution |
| `/agents` | Show current state of all agents |
| `/goals` | List active goals with task status |
| `/cancel` | Cancel all active goals |

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

## Agent Selection

When assigning a task, the mind picks agents in this order:

1. **Idle agent matching target cwd/project**: best match, reuses existing context
2. **Idle agent matching agent type**: right tool for the job
3. **Any idle agent**: fallback
4. **Spawn new agent**: if under the spawn limit (default 4)

Spawned agents get `autoApprove: true` since the mind coordinates their work.

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

- **Task timeout**: 5–15 minutes per task depending on policy. Timed-out tasks go through the re-plan flow.
- **No arm available**: the mind spawns one (up to `maxSpawned`). If the spawn cap is hit, the task fails.
- **Agent unreachable**: task fails if `sendToAgent` returns false; the re-plan flow runs.
- **Dependency failure**: if a task abandons, all transitively-dependent tasks cascade-fail.
- **Planning failure**: if the reasoner can't produce a plan, the goal fails with the reasoner's error.
- **Server restart**: all in-flight goals reported as interrupted on next start (see above).

## File Structure

```
src/mind/
  index.js           # Module entry, createMind(), instance registration, command handling
  world-model.js     # Real-time agent state mirror via InstanceManager events
  coordinator.js     # Goal/task lifecycle, assignment, completion detection,
                     #   inter-arm context, re-plan, memory + goal-store wiring
  reasoner.js        # LLM planning + evaluate + replan, via Claude Code process
  task-runner.js     # DAG executor: parallel + sequential tasks
  agent-pool.js      # Arm reuse/spawning (only reuses mind-spawned arms)
  watcher.js         # Passive monitoring + policy-gated auto-cancel of stuck tasks
  policies.js        # Configurable autonomy levels (conservative/balanced/autonomous)
  memory.js          # Long-term goal memory (JSONL, Jaccard search)
  goal-store.js      # In-flight goal persistence (JSON, atomic rewrite)
```

## Autonomous Monitoring (Watcher)

The watcher runs every 30 seconds and acts in two stages:

**Stage 1 — Alert (all policies)**
- **Stuck agents**: busy for longer than `stuckThreshold` without status change → posts a warning in the mind's chat
- **Stale approvals**: agents waiting for approval → posts a reminder
- **Alert deduplication**: each issue is reported once, cleared when resolved, re-reported if it recurs

**Stage 2 — Act (`autoActOnStuck` policies)**
- If a stuck agent is running a coordinator-owned task AND its busy time exceeds `stuckThreshold × stuckActionMultiplier`, the watcher calls `coordinator.failAgentTask(...)`. This aborts the arm and routes the failure through the normal re-plan path (retry / split / abandon). User sessions and gateway-spawned arms are untouched — only mind-owned tasks are auto-cancelled.

The watcher emits a single "🛑 Auto-cancelled" message in the mind's chat when it acts, so the user always sees what happened.

## Policies

Three autonomy levels control the mind's behavior:

| Policy | Auto-approve spawned | Max concurrent | Max spawned | Task timeout | Stuck threshold | Auto-act on stuck | Action multiplier |
|--------|---------------------|----------------|-------------|--------------|-----------------|-------------------|-------------------|
| `conservative`        | No  | 2 | 2 | 5 min  | 10 min | No  | — |
| `balanced` (default)  | Yes | 4 | 4 | 10 min | 15 min | Yes | 2× (act at 30 min) |
| `autonomous`          | Yes | 8 | 6 | 15 min | 20 min | Yes | 1× (act at 20 min) |

Set via environment variable:
```bash
POLPO_MIND_POLICY=conservative POLPO_MIND=1 node bin/polpo.js server
```

## Security

- **Opt-in**: only loads when `POLPO_MIND=1` is set
- **No new dependencies**: pure Node.js, uses existing agent infrastructure
- **Process isolation**: the reasoner's Claude process uses `--dangerously-skip-permissions` but only generates JSON plans, never touches user code
- **Spawn limits**: `maxSpawned` prevents unbounded agent creation
- **Event cleanup**: `destroy()` removes all listeners, kills processes, clears timeouts
- **No secrets handling**: the mind doesn't manage tokens or credentials
