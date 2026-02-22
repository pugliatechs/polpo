/**
 * AgentFactory — routes agent creation by type.
 *
 * Supported types:
 *   - 'claude' (default) → WrappedAgent (Claude Code CLI)
 *   - 'codex'            → CodexAgent (OpenAI Codex CLI)
 */

function createAgent(type, options) {
  if (type === 'codex') {
    const { CodexAgent } = require('./codex-agent');
    return new CodexAgent(options);
  }
  const { WrappedAgent } = require('./wrapped');
  return new WrappedAgent(options);
}

module.exports = { createAgent };
