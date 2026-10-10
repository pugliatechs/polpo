const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, redactDeep, MARK } = require('../src/server/redact');

/**
 * Secrets in session text the gateway returns.
 *
 * The case that prompted this: an agent pasted a production API key into
 * a shell command, the command waited for approval, and the gateway
 * handed the command to an external assistant. Fixtures are assembled at
 * runtime so nothing secret-shaped sits in the source.
 */

const j = (...parts) => parts.join('');
const RANDOM = 'Ab3dEf9hIj2kLm8nOp1qRs7tUv4wXy6zAB0cD-eFgH5iJk=';

function redacts(text, secret) {
  const r = redactSecrets(text);
  assert.equal(r.redacted, true, 'redacted: ' + text);
  assert.ok(!r.text.includes(secret), 'secret survived: ' + r.text);
  assert.ok(r.text.includes(MARK));
}

function keeps(text) {
  const r = redactSecrets(text);
  assert.equal(r.redacted, false, 'over-redacted: ' + r.text);
  assert.equal(r.text, text);
}

describe('redactSecrets', () => {
  const saved = process.env.POLPO_GATEWAY_REDACT;
  afterEach(() => {
    if (saved === undefined) delete process.env.POLPO_GATEWAY_REDACT;
    else process.env.POLPO_GATEWAY_REDACT = saved;
  });

  it('removes a key pasted into a command', () => {
    const key = j('fmpro', '_', RANDOM);
    redacts("umask 077; printf '%s' '" + key + "' > /tmp/.key", key);
  });

  it('removes tokens with a well-known prefix', () => {
    for (const t of [
      j('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
      j('sk-', 'ant-', 'api03-a1B2c3D4e5F6g7H8i9J0k1L2'),
      j('gl', 'pat-', 'a1B2c3D4e5F6g7H8i9J0'),
      j('xo', 'xb-', '1234567890-abcdefghij'),
      j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
    ]) redacts('export T=' + t, t);
  });

  it('removes JWTs', () => {
    const jwt = j('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.SflKxwRJSMeKKF2QT4fwpMeJf36P');
    redacts('cookie=' + jwt, jwt);
  });

  it('removes a bearer token but keeps the scheme', () => {
    const t = j('abcDEF123', 'ghiJKL456mno');
    const r = redactSecrets('curl -H "Authorization: Bearer ' + t + '"');
    assert.equal(r.text, 'curl -H "Authorization: Bearer ' + MARK + '"');
  });

  it('removes the value of a name that says it is a secret', () => {
    redacts('DB_PASSWORD=hunter2hunter2 ./run', 'hunter2hunter2');
    redacts('{"apiKey": "Zx81kq0PLm4"}', 'Zx81kq0PLm4');
    redacts('client_secret: s3cr3tValue99', 's3cr3tValue99');
  });

  it('removes a private key block', () => {
    const body = 'b3BlbnNzaC1rZXktdjEAAAAA';
    redacts(j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\n', body, '\n-----END OPENSSH ', 'PRIVATE KEY-----'), body);
  });

  it('leaves references to secrets alone', () => {
    keeps('curl -H "Authorization: Bearer $KEY" http://x');
    keeps('POLPO_GATEWAY_KEY=$KEY polpo gateway');
    keeps('const token = getToken(); const secret = process.env.SECRET;');
    keeps('max_tokens: 32000');
  });

  it('leaves hashes, ids, paths and prose alone', () => {
    keeps('merged as 524280b3f1c2a9e8d7b6a5c4d3e2f1a0b9c8d7e6');
    keeps('sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    keeps('session 4b1f4bb6-14e6-49d8-89a7-411d362c78bf');
    keeps('/home/u/Documents/pugliatechs/documents/2026/comunicazione-invito-regione');
    keeps('TestSessionControlTakeoverWorksWhenIdleAndNotBusy');
    keeps('The GRUB semicolon that stopped live ISOs installing themselves was fixed in 40653c1.');
  });

  it('stays fast on hostile input', () => {
    const t0 = Date.now();
    redactSecrets('a.b-'.repeat(5000));
    redactSecrets('x'.repeat(20000));
    redactSecrets('-----BEGIN RSA PRIVATE KEY-----' + 'A'.repeat(20000));
    redactSecrets('password'.repeat(2500));
    assert.ok(Date.now() - t0 < 1000);
  });

  it('can be turned off', () => {
    process.env.POLPO_GATEWAY_REDACT = '0';
    const key = j('fmpro', '_', RANDOM);
    assert.equal(redactSecrets(key).text, key);
  });
});

describe('redactDeep', () => {
  it('redacts strings inside content blocks without touching the input', () => {
    const key = j('fmpro', '_', RANDOM);
    const blocks = [{ type: 'tool_use', input: { command: 'echo ' + key } }, { type: 'text', text: 'ok' }];
    const out = redactDeep(blocks);
    assert.ok(!JSON.stringify(out).includes(key));
    assert.equal(out[1].text, 'ok');
    assert.ok(blocks[0].input.command.includes(key), 'input unchanged');
  });
});
