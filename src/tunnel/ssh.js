const { spawn, execFileSync } = require('child_process');

const name = 'ssh';

function isAvailable() {
  try {
    execFileSync('which', ['ssh'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function start(port, opts = {}) {
  const tunnelHost = opts.tunnelHost;
  if (!tunnelHost) {
    return Promise.reject(new Error('ssh: --tunnel-host is required (e.g. user@myserver.com)'));
  }

  const tunnelPort = opts.tunnelPort || 80;

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-N',
      '-R', `${tunnelPort}:localhost:${port}`,
      tunnelHost,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountInterval=3',
      '-o', 'ExitOnForwardFailure=yes',
    ], {
      stdio: ['inherit', 'ignore', 'pipe'], // inherit stdin for passphrase prompts
    });

    let resolved = false;
    let stderrBuf = '';

    child.stderr.on('data', (data) => {
      stderrBuf += data.toString();
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
        const hint = stderrBuf.trim() ? `: ${stderrBuf.trim().split('\n').pop()}` : '';
        reject(new Error(`ssh exited with code ${code}${hint}`));
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

module.exports = { name, isAvailable, start };
