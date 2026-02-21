#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

const flags = parseFlags(args);

function printHelp() {
  console.log(`
  🐙 Polpo — Claude Code Mobile Controller

  USAGE
    polpo <command> [options]

  COMMANDS
    server      Start the Polpo hub server
    session     Start a Claude Code session controllable from your phone
    agent       Start a lightweight stdin/stdout agent (legacy)
    bridge      Start a hook bridge daemon for Claude Code integration
    hooks       Print Claude Code hook configuration JSON
    help        Show this help message

  SERVER OPTIONS
    --port <n>      Port to listen on (default: 7890)
    --host <addr>   Host to bind to (default: 0.0.0.0)
    --tunnel [provider]  Start a tunnel for remote phone access
                         Providers: cloudflared, localtunnel, ngrok, ssh
                         Omit provider to auto-detect (tries cloudflared, then localtunnel)
    --tunnel-host <host> SSH tunnel host (required for ssh provider, e.g. user@server)
    --tunnel-port <n>    Remote port for SSH tunnel (default: 80)
    --auth <mode>   Authentication mode (auto-enabled for tunnels):
                      token    — Single-use URL token only (default for tunnels)
                      pin      — Token + 4-digit PIN displayed in terminal
                      paranoid — Token + TOTP via authenticator app
    --token <tok>   Use a specific token instead of auto-generating one
    --verbose       Enable verbose logging

  AGENT OPTIONS
    --name <name>       Display name for this instance
    --type <type>       Instance type: terminal | vscode (default: terminal)
    --project <name>    Project name (default: current directory name)
    --server <url>      Polpo server WebSocket URL (default: ws://127.0.0.1:7890)
    --token <tok>       Auth token (or set POLPO_TOKEN env var)

  SESSION OPTIONS
    --name <name>       Display name for this session
    --cwd <dir>         Project directory to work in (default: current)
    --resume <id>       Resume an existing Claude Code session
    --model <model>     Model to use (e.g. opus, sonnet)
    --permissions <m>   Permission mode: default | bypass (default: default)
    --server <url>      Polpo server WebSocket URL (default: ws://127.0.0.1:7890)
    --token <tok>       Auth token (or set POLPO_TOKEN env var)

  BRIDGE OPTIONS
    --name <name>       Display name for this instance
    --type <type>       Instance type: terminal | vscode (default: vscode)
    --project <name>    Project name (default: current directory name)
    --server <url>      Polpo server WebSocket URL (default: ws://127.0.0.1:7890)
    --token <tok>       Auth token (or set POLPO_TOKEN env var)
    --cwd <dir>         Working directory (default: current directory)

  EXAMPLES
    # Start the hub server
    polpo server

    # Start the hub on a custom port
    polpo server --port 8080

    # Register a terminal Claude Code instance
    polpo agent --name "Backend refactor" --type terminal

    # Register a VS Code instance
    polpo agent --name "Frontend UI" --type vscode

    # Start a phone-controllable Claude Code session
    polpo session --cwd /path/to/project --name "Backend work"

    # Resume an existing session from your phone
    polpo session --resume <session-id>

    # Start a hook bridge (usually auto-started by hooks)
    polpo bridge --name "My Project"

    # Print Claude Code hook config to add to settings.json
    polpo hooks

  TUNNEL EXAMPLES
    # Auto-detect best available tunnel provider
    polpo server --tunnel

    # Use a specific provider
    polpo server --tunnel cloudflared
    polpo server --tunnel localtunnel
    polpo server --tunnel ngrok

    # SSH reverse tunnel
    polpo server --tunnel ssh --tunnel-host user@myserver.com
    polpo server --tunnel ssh --tunnel-host user@myserver.com --tunnel-port 8080

  MOBILE ACCESS
    Once the server is running, open http://<your-computer-ip>:7890
    on your phone's browser (must be on the same network).

    With --tunnel, a public URL and QR code are displayed for scanning
    from any network (no VPN/LAN required).
`);
}

async function runServer() {
  const { createServer } = require('../src/server/index');
  const { generateToken, generatePin, generateTotpSecret, buildTotpUri, loadTotpSecret, saveTotpSecret } = require('../src/server/auth');

  // Determine auth mode
  const useTunnel = !!flags.tunnel;
  let authMode = flags.auth || null;
  let token = flags.token || null;

  // Auto-enable token auth for tunnels (unless explicitly disabled with --auth none)
  if (useTunnel && !authMode) {
    authMode = 'token';
  }

  // Generate token if auth is enabled and none was provided
  if (authMode && authMode !== 'none' && !token) {
    token = generateToken();
  }

  const authOpts = {};
  if (token) {
    authOpts.token = token;
    authOpts.mode = authMode === 'paranoid' ? 'paranoid' : authMode === 'pin' ? 'pin' : null;
  }

  const server = createServer({
    port: parseInt(flags.port) || 7890,
    host: flags.host || '0.0.0.0',
    verbose: !!flags.verbose,
    auth: Object.keys(authOpts).length > 0 ? authOpts : undefined,
  });

  // Set up PIN callback for terminal display
  if (authMode === 'pin') {
    const pin = generatePin();
    server.authState.pin = pin;
    server.authState.onPinRegenerated = (newPin) => {
      console.log(`\n  🔑 New PIN: ${newPin}\n`);
    };
  }

  // Set up TOTP for paranoid mode
  if (authMode === 'paranoid') {
    const os = require('os');
    const configPath = require('path').join(os.homedir(), '.config', 'polpo', 'totp.json');
    let secret = loadTotpSecret(configPath);
    const isNewSecret = !secret;
    if (!secret) {
      secret = generateTotpSecret();
      saveTotpSecret(configPath, secret);
    }
    const totpUri = buildTotpUri(secret, 'Polpo');
    const qrcode = require('qrcode-terminal');
    if (isNewSecret) {
      console.log('\n  ┌─────────────────────────────────────────────┐');
      console.log('  │  🔐 TOTP Setup — scan with AUTHENTICATOR APP │');
      console.log('  └─────────────────────────────────────────────┘\n');
    } else {
      console.log('\n  ┌─────────────────────────────────────────────┐');
      console.log('  │  🔐 TOTP — scan with AUTHENTICATOR APP      │');
      console.log('  └─────────────────────────────────────────────┘\n');
    }
    qrcode.generate(totpUri, { small: true }, (qr) => {
      const indented = qr.split('\n').map((line) => '    ' + line).join('\n');
      console.log(indented);
      console.log(`\n     Secret: ${secret}`);
      if (isNewSecret) {
        console.log('     Add to Google Authenticator, Authy, etc.');
      }
      console.log('');
    });
    server.authState.totpSecret = secret;
  }

  await server.start();

  const port = parseInt(flags.port) || 7890;
  let tunnel = null;

  // Start tunnel if requested
  if (useTunnel) {
    try {
      const { startTunnel } = require('../src/tunnel/index');
      const { displayQR } = require('../src/tunnel/qr');
      tunnel = await startTunnel({
        provider: flags.tunnel,
        port,
        tunnelHost: flags['tunnel-host'],
        tunnelPort: flags['tunnel-port'] ? parseInt(flags['tunnel-port']) : undefined,
      });

      // Build URL with token baked in for QR code
      let tunnelUrl = tunnel.url;
      if (token) {
        tunnelUrl += `?token=${token}`;
      }

      console.log(`  🌐 Tunnel active: ${tunnel.url}`);
      if (token) {
        console.log(`  🔒 Auth enabled (mode: ${authMode || 'token'})`);
        if (authMode === 'pin') {
          console.log(`  🔑 PIN: ${server.authState.pin}`);
        }
      }
      displayQR(tunnelUrl);
    } catch (err) {
      console.error(`  ⚠️  Tunnel failed: ${err.message}`);
      console.log('  Server is still running on LAN.\n');
    }
  }

  // Print local network addresses for convenience
  if (!tunnel) {
    try {
      const os = require('os');
      const nets = os.networkInterfaces();
      const addresses = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            addresses.push(net.address);
          }
        }
      }
      if (addresses.length > 0) {
        console.log('  📱 Open on your phone (same network):');
        addresses.forEach((addr) => {
          const url = token
            ? `http://${addr}:${port}?token=${token}`
            : `http://${addr}:${port}`;
          console.log(`     ${url}`);
        });
        if (token && authMode === 'pin') {
          console.log(`\n  🔑 PIN: ${server.authState.pin}`);
        }
        console.log('');
      }
    } catch (e) {
      // not critical
    }
  }

  // Print token for agent/bridge connections
  if (token) {
    console.log(`  🔑 Agent token: ${token}`);
    console.log('     Pass to agents: polpo session --server ws://host:port --token <token>\n');
  }

  process.on('SIGINT', async () => {
    console.log('\n  Shutting down...');
    if (tunnel) {
      try { tunnel.close(); } catch (e) { /* ignore */ }
    }
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    if (tunnel) {
      try { tunnel.close(); } catch (e) { /* ignore */ }
    }
    await server.stop();
    process.exit(0);
  });
}

async function runAgent() {
  const { runStandalone } = require('../src/agent/index');
  await runStandalone({
    name: flags.name,
    type: flags.type,
    project: flags.project,
    serverUrl: flags.server ? flags.server : undefined,
  });
}

async function runSession() {
  const { runWrapped } = require('../src/agent/wrapped');
  await runWrapped({
    name: flags.name,
    cwd: flags.cwd || process.cwd(),
    resumeSessionId: flags.resume || undefined,
    model: flags.model || undefined,
    permissionMode: flags.permissions || 'default',
    serverUrl: flags.server || undefined,
    token: flags.token || process.env.POLPO_TOKEN || undefined,
  });
}

function runBridge() {
  const { spawn } = require('child_process');
  const bridgePath = require('path').join(__dirname, '..', 'src', 'hooks', 'bridge.js');
  const child = spawn('node', [bridgePath, ...args.slice(1)], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

function printHooks() {
  const path = require('path');
  const polpoDir = path.resolve(__dirname, '..');
  const hooksDir = path.join(polpoDir, 'src', 'hooks');

  const config = {
    hooks: {
      PreToolUse: [
        {
          matcher: '',
          command: `node ${path.join(hooksDir, 'pre-tool-use.js')}`,
        },
      ],
      PostToolUse: [
        {
          matcher: '',
          command: `node ${path.join(hooksDir, 'post-tool-use.js')}`,
        },
      ],
      Notification: [
        {
          matcher: '',
          command: `node ${path.join(hooksDir, 'notification.js')}`,
        },
      ],
      UserPromptSubmit: [
        {
          matcher: '',
          command: `node ${path.join(hooksDir, 'user-prompt-submit.js')}`,
        },
      ],
    },
  };

  console.log('\n  Add this to your Claude Code settings.json (~/.claude/settings.json):\n');
  console.log(JSON.stringify(config, null, 2));
  console.log('\n  Or for phone-based approval mode, set POLPO_APPROVE=1 in the PreToolUse command:');
  console.log(`  "command": "POLPO_APPROVE=1 node ${path.join(hooksDir, 'pre-tool-use.js')}"\n`);
}

switch (command) {
  case 'server':
    runServer().catch((err) => {
      console.error('Failed to start server:', err.message);
      process.exit(1);
    });
    break;

  case 'session':
    runSession().catch((err) => {
      console.error('Failed to start session:', err.message);
      process.exit(1);
    });
    break;

  case 'agent':
    runAgent().catch((err) => {
      console.error('Failed to start agent:', err.message);
      process.exit(1);
    });
    break;

  case 'bridge':
    runBridge();
    break;

  case 'hooks':
    printHooks();
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
