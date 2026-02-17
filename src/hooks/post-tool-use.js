#!/usr/bin/env node

/**
 * Polpo PostToolUse Hook
 *
 * Called by Claude Code after each tool use.
 * Reports tool completion and result summary to the bridge.
 *
 * Stdin format (from Claude Code):
 *   { "tool_name": "Bash", "tool_input": {...}, "tool_output": "..." }
 *
 * This hook is fire-and-forget — it never blocks.
 */

const { ensureBridge, send, readStdin } = require('./client');

(async () => {
  try {
    const hookData = await readStdin();
    if (!hookData || !hookData.tool_name) {
      process.exit(0);
    }

    const toolName = hookData.tool_name;
    const toolInput = hookData.tool_input || {};
    const toolOutput = hookData.tool_output;

    // Build a compact result summary
    let summary = `[${toolName}] done`;

    if (toolName === 'Bash' || toolName === 'bash') {
      const cmd = toolInput.command || '';
      const shortCmd = cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
      if (typeof toolOutput === 'string' && toolOutput.length > 0) {
        const lines = toolOutput.split('\n');
        const shortOutput =
          lines.length > 3
            ? lines.slice(0, 3).join('\n') + `\n... (${lines.length} lines)`
            : toolOutput;
        summary = `$ ${shortCmd}\n${shortOutput}`;
      } else {
        summary = `$ ${shortCmd} (no output)`;
      }
    } else if (toolName === 'Write' || toolName === 'Edit') {
      summary = `[${toolName}] ${toolInput.file_path || ''}`;
    } else if (toolName === 'Read') {
      summary = `[Read] ${toolInput.file_path || ''}`;
    }

    // Cap summary length
    if (summary.length > 500) {
      summary = summary.slice(0, 500) + '...';
    }

    const socketPath = await ensureBridge({ cwd: process.cwd() });

    await send(socketPath, {
      type: 'tool_result',
      tool: toolName,
      content: summary,
    });

    // Tool is done, back to busy (Claude Code is still processing)
    await send(socketPath, {
      type: 'status',
      status: 'busy',
    });
  } catch (e) {
    // Never block Claude Code on errors
  }

  process.exit(0);
})();
