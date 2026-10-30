/**
 * Runs a milestone's gate, outside the agent.
 *
 * The gate is an argv run without a shell, in the repository, as the
 * user polpo runs as, with the milestone's timeout. Its output goes to a
 * log file; what is recorded is the commit, the state of the working
 * tree, the exit code, the duration, the log's sha256 and its tail. The
 * agent is never asked whether its gate passed.
 *
 * See docs/campaigns.md, section 4.3.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const TAIL_LINES = 200;
const TAIL_BYTES = 256 * 1024;
const KILL_GRACE_MS = 5000;

function git(cwd, args, maxBuffer) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: maxBuffer || 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * The commit and the state of the working tree.
 * @returns {Promise<{commit: ?string, dirty: boolean, treeHash: ?string}>}
 *   `treeHash` hashes the uncommitted changes (null on a clean tree), so
 *   two runs on the same commit with different edits are told apart.
 */
async function gitState(cwd) {
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 16 * 1024 * 1024);
  if (!head && !status) return { commit: null, dirty: false, treeHash: null };
  const dirty = !!(status && status.length);
  let treeHash = null;
  if (dirty) {
    const diff = await git(cwd, ['diff', 'HEAD', '--binary'], 64 * 1024 * 1024);
    treeHash = crypto.createHash('sha256').update(status).update(diff || 'diff-unavailable').digest('hex');
  }
  return { commit: head ? head.toString('utf8').trim() : null, dirty, treeHash };
}

/** The last `n` lines of a buffer's text. */
function tailLines(buf, n) {
  const lines = buf.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

/**
 * Run one gate.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string[]} opts.argv
 * @param {number} opts.timeoutMs
 * @param {string} opts.logPath - written with mode 0600
 * @param {object} [opts.env]
 * @returns {{done: Promise<object>, cancel: () => void}} the result has
 *   exit, signal, timedOut, durationMs, logSha256, tail, error
 */
function runGate(opts) {
  const started = Date.now();
  const hash = crypto.createHash('sha256');
  const log = fs.createWriteStream(opts.logPath, { mode: 0o600 });
  let tail = Buffer.alloc(0);
  let timedOut = false;
  let child;
  let killTimer = null;

  function onData(chunk) {
    hash.update(chunk);
    log.write(chunk);
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
  }

  function killGroup(sig) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // detached: the gate leads its own process group, so whatever it
    // started goes too.
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
  }

  const done = new Promise((resolve) => {
    let settled = false;
    let timer = null;
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      log.end(() => {
        resolve(Object.assign({
          durationMs: Date.now() - started,
          logSha256: hash.digest('hex'),
          tail: tailLines(tail, TAIL_LINES),
          timedOut,
        }, result));
      });
    }

    try {
      child = spawn(opts.argv[0], opts.argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env || process.env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ exit: null, signal: null, error: err.message });
      return;
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      onData(Buffer.from('[polpo] gate could not start: ' + err.message + '\n'));
      finish({ exit: null, signal: null, error: err.message });
    });
    child.on('close', (code, signal) => finish({ exit: code, signal: signal || null, error: null }));

    timer = setTimeout(() => {
      timedOut = true;
      onData(Buffer.from('\n[polpo] gate timed out after ' + Math.round(opts.timeoutMs / 1000) + 's\n'));
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs);
  });

  return {
    done,
    cancel() {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    },
  };
}

module.exports = { runGate, gitState, tailLines, TAIL_LINES };
