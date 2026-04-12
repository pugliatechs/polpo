# Alien Mind: Meta-Agent Coordination

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
    |-- Reasoner: spawns Claude Code for goal decomposition
    |-- Coordinator: manages goal/task lifecycle
    |-- TaskRunner: DAG executor for parallel + sequential tasks
    |-- AgentPool: reuses idle agents or spawns new ones
    |
    +-- Agent 1 (Claude, /project-backend) -- Task A
    +-- Agent 2 (Goose, /project-infra)   -- Task B
    +-- Agent 3 (Codex, /project-frontend) -- Task C (depends on A)
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

## Failure Handling

- **Task timeout**: 5 minutes per task (configurable). Timed-out tasks are marked failed.
- **No idle agent**: task fails immediately with "No agent available"
- **Agent unreachable**: task fails if `sendToAgent` returns false
- **Dependency failure**: if a task fails, all tasks that depend on it are cascade-failed
- **Planning failure**: if the reasoner can't produce a plan, the goal fails with an error message

## File Structure

```
src/mind/
  index.js           # Module entry, createMind(), instance registration, command handling
  world-model.js     # Real-time agent state mirror via InstanceManager events
  coordinator.js     # Goal/task lifecycle, assignment, completion detection
  reasoner.js        # LLM planning via Claude Code process
  task-runner.js     # DAG executor: parallel + sequential tasks
  agent-pool.js      # Agent reuse/spawning logic
```

## Security

- **Opt-in**: only loads when `POLPO_MIND=1` is set
- **No new dependencies**: pure Node.js, uses existing agent infrastructure
- **Process isolation**: the reasoner's Claude process uses `--dangerously-skip-permissions` but only generates JSON plans, never touches user code
- **Spawn limits**: `maxSpawned` prevents unbounded agent creation
- **Event cleanup**: `destroy()` removes all listeners, kills processes, clears timeouts
- **No secrets handling**: the mind doesn't manage tokens or credentials
