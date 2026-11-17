const { spawn, execFileSync } = require('child_process');
const { createOutputTail } = require('./output-tail');

const name = 'ssh';

function isAvailable() {
  try {
    execFileSync('which', ['ssh'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ssh command line for the reverse tunnel. Options come before the
 * destination, as ssh(1) documents them. ServerAliveCountMax (not
 * "ServerAliveCountInterval", which ssh rejects as a bad option and exits)
 * drops the tunnel after 3 unanswered keepalives, 90 s with the 30 s
 * interval.
 */
function buildArgs(port, tunnelHost, tunnelPort) {
  return [
    '-N',
    '-R', `${tunnelPort}:localhost:${port}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    tunnelHost,
  ];
}

function start(port, opts = {}) {
  const tunnelHost = opts.tunnelHost;
  if (!tunnelHost) {
    return Promise.reject(new Error('ssh: --tunnel-host is required (e.g. user@myserver.com)'));
  }

  const tunnelPort = opts.tunnelPort || 80;

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', buildArgs(port, tunnelHost, tunnelPort), {
      stdio: ['inherit', 'ignore', 'pipe'], // inherit stdin for passphrase prompts
    });

    let resolved = false;
    // Bounded, and only fed until the tunnel is up: the old buffer kept
    // growing for as long as the ssh process lived.
    const tail = createOutputTail();

    child.stderr.on('data', (data) => {
      if (!resolved) tail.push(data);
    });

    // SSH doesn't output a URL. Detect success by waiting for the process
    // to stay alive for 3 seconds (it exits immediately on failure).
    const successTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const host = tunnelHost.includes('@') ? tunnelHost.split('@').pop() : tunnelHost;
        const scheme = tunnelPort === 443 ? 'https' : 'http';
        const portSuffix = (tunnelPort === 80 || tunnelPort === 443) ? '' : `:${tunnelPort}`;
        resolve({
          url: `${scheme}://${host}${portSuffix}`,
          close: () => killChild(child),
          onExit: (cb) => child.once('exit', cb),
        });
      }
    }, 3000);

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(successTimer);
        reject(new Error(`ssh: ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(successTimer);
        reject(new Error(`ssh exited with code ${code}${tail.hint()}`));
      }
    });
  });
}

function killChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 5000);
}

module.exports = { name, isAvailable, start, buildArgs };
