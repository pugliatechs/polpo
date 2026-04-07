const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadPaConfig, parseAllowFrom, validateAgentType, VALID_AGENT_TYPES } = require('../src/pa/config');

describe('PA config', () => {
  const savedEnv = {};

  beforeEach(() => {
    // Save and clear PA env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('POLPO_PA_')) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('POLPO_PA_')) delete process.env[key];
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      process.env[key] = val;
    }
  });

  it('returns enabled:false when no token', () => {
    const config = loadPaConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.telegram.token, null);
  });

  it('returns enabled:true when token is set via env', () => {
    process.env.POLPO_PA_TELEGRAM_TOKEN = '123:ABC';
    const config = loadPaConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.telegram.token, '123:ABC');
  });

  it('parses allowFrom from comma-separated env var', () => {
    process.env.POLPO_PA_TELEGRAM_TOKEN = 'tok';
    process.env.POLPO_PA_TELEGRAM_ALLOW = '12345,myuser,67890';
    const config = loadPaConfig();
    assert.deepEqual(config.telegram.allowFrom, [12345, 'myuser', 67890]);
  });

  it('uses default agent config', () => {
    process.env.POLPO_PA_TELEGRAM_TOKEN = 'tok';
    const config = loadPaConfig();
    assert.equal(config.agent.name, 'Personal Assistant');
    assert.equal(config.agent.model, null);
  });

  it('reads agent config from env', () => {
    process.env.POLPO_PA_TELEGRAM_TOKEN = 'tok';
    process.env.POLPO_PA_AGENT_NAME = 'MyBot';
    process.env.POLPO_PA_AGENT_MODEL = 'opus';
    const config = loadPaConfig();
    assert.equal(config.agent.name, 'MyBot');
    assert.equal(config.agent.model, 'opus');
  });

  it('reads auth config with defaults', () => {
    process.env.POLPO_PA_TELEGRAM_TOKEN = 'tok';
    const config = loadPaConfig();
    assert.equal(config.auth.checkIntervalMinutes, 5);
    assert.equal(config.auth.expiryBufferMinutes, 15);
    assert.equal(config.auth.autoRefresh, true);
  });

  it('defaults agent type to claude', () => {
    process.env.POLPO_PA_TELEGRAM_TOKEN = 'tok';
    const config = loadPaConfig();
    assert.equal(config.agent.type, 'claude');
  });

  it('reads agent type from env', () => {
    process.env.POLPO_PA_TELEGRAM_TOKEN = 'tok';
    process.env.POLPO_PA_AGENT_TYPE = 'codex';
    const config = loadPaConfig();
    assert.equal(config.agent.type, 'codex');
  });

  it('validates invalid agent type to claude', () => {
    process.env.POLPO_PA_TELEGRAM_TOKEN = 'tok';
    process.env.POLPO_PA_AGENT_TYPE = 'invalid';
    const config = loadPaConfig();
    assert.equal(config.agent.type, 'claude');
  });
});

describe('parseAllowFrom', () => {
  it('returns empty for null/undefined', () => {
    assert.deepEqual(parseAllowFrom(null), []);
    assert.deepEqual(parseAllowFrom(undefined), []);
  });

  it('passes through arrays', () => {
    assert.deepEqual(parseAllowFrom([123, 'user']), [123, 'user']);
  });

  it('parses comma-separated string with numbers and strings', () => {
    assert.deepEqual(parseAllowFrom('123,user,456'), [123, 'user', 456]);
  });

  it('handles whitespace', () => {
    assert.deepEqual(parseAllowFrom(' 123 , user , 456 '), [123, 'user', 456]);
  });

  it('filters empty entries', () => {
    assert.deepEqual(parseAllowFrom('123,,456'), [123, 456]);
  });
});

describe('validateAgentType', () => {
  it('accepts all valid types', () => {
    for (const type of VALID_AGENT_TYPES) {
      assert.equal(validateAgentType(type), type);
    }
  });

  it('defaults invalid type to claude', () => {
    assert.equal(validateAgentType('invalid'), 'claude');
    assert.equal(validateAgentType(''), 'claude');
  });
});

describe('VALID_AGENT_TYPES', () => {
  it('includes expected agents', () => {
    assert.ok(VALID_AGENT_TYPES.includes('claude'));
    assert.ok(VALID_AGENT_TYPES.includes('codex'));
    assert.ok(VALID_AGENT_TYPES.includes('gemini'));
    assert.ok(VALID_AGENT_TYPES.includes('pi'));
    assert.ok(VALID_AGENT_TYPES.includes('opencode'));
  });
});
