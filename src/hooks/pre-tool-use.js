#!/usr/bin/env node

/**
 * Polpo PreToolUse Hook
 *
 * Called by Claude Code before each tool use.
 * Receives tool info on stdin, reports it to the bridge.
 *
 * Two modes:
 *   - Monitor (default): reports tool use to the phone, exits immediately.
 *   - Approval (POLPO_APPROVE=1): blocks until the phone user approves/rejects.
 *     Outputs {"decision":"block","reason":"..."} to stdout if rejected.
 *
 * Stdin format (from Claude Code):
 *   { "tool_name": "Bash", "tool_input": { "command": "..." }, ... }
 *
 * IMPORTANT: This hook must never crash or hang indefinitely.
 * On any error, it exits cleanly (tool proceeds).
 */

const { ensureBridge, send, request, readStdin } = require('./client');
const crypto = require('crypto');

const APPROVAL_MODE = process.env.POLPO_APPROVE === '1';
const APPROVAL_TIMEOUT = parseInt(process.env.POLPO_TIMEOUT) || 5 * 60 * 1000;

(async () => {
  try {
    const hookData = await readStdin();
    if (!hookData || !hookData.tool_name) {
      process.exit(0);
    }

    const toolName = hookData.tool_name;
    const toolInput = hookData.tool_input || {};
    const sessionId = hookData.session_id || null;
    const transcriptPath = hookData.transcript_path || null;

    // Build a human-readable description
    let description = toolName;
    let command = '';

    if (toolName === 'Bash' || toolName === 'bash') {
      command = toolInput.command || '';
      description = command
        ? `Run: ${command.length > 120 ? command.slice(0, 120) + '...' : command}`
        : 'Run shell command';
    } else if (toolName === 'Write' || toolName === 'write') {
      description = `Write file: ${toolInput.file_path || ''}`;
    } else if (toolName === 'Edit' || toolName === 'edit') {
      description = `Edit file: ${toolInput.file_path || ''}`;
    } else if (toolName === 'Read' || toolName === 'read') {
      description = `Read file: ${toolInput.file_path || ''}`;
    } else if (toolName === 'Glob' || toolName === 'glob') {
      description = `Search files: ${toolInput.pattern || ''}`;
    } else if (toolName === 'Grep' || toolName === 'grep') {
      description = `Search content: ${toolInput.pattern || ''}`;
    } else if (toolName === 'WebFetch') {
      description = `Fetch URL: ${toolInput.url || ''}`;
    } else if (toolName === 'Task') {
      description = `Spawn agent: ${toolInput.description || ''}`;
    }

    const socketPath = await ensureBridge({ cwd: process.cwd() });

    if (APPROVAL_MODE) {
      // Block until phone user approves or rejects
      const requestId = crypto.randomUUID();
      const response = await request(
        socketPath,
        {
          type: 'approval_request',
          requestId,
          tool: toolName,
          description,
          command,
          timeout: APPROVAL_TIMEOUT,
          sessionId,
          transcriptPath,
        },
        APPROVAL_TIMEOUT + 5000
      );

      if (response.decision === 'block') {
        // Output rejection so Claude Code blocks the tool
        process.stdout.write(
          JSON.stringify({ decision: 'block', reason: 'Rejected via Polpo' }) + '\n'
        );
      }
      // 'allow' or anything else → exit cleanly, tool proceeds
    } else {
      // Monitor mode: report and exit immediately
      await send(socketPath, {
        type: 'tool_start',
        tool: toolName,
        description,
        command,
        sessionId,
        transcriptPath,
      });
    }
  } catch (e) {
    // Never block Claude Code on errors
  }

  process.exit(0);
})();
