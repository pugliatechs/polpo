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
    agent       Start an agent that connects a Claude Code instance to the hub
    help        Show this help message

  SERVER OPTIONS
    --port <n>      Port to listen on (default: 7890)
    --host <addr>   Host to bind to (default: 0.0.0.0)
    --verbose       Enable verbose logging

  AGENT OPTIONS
    --name <name>       Display name for this instance
    --type <type>       Instance type: terminal | vscode (default: terminal)
    --project <name>    Project name (default: current directory name)
    --server <url>      Polpo server WebSocket URL (default: ws://127.0.0.1:7890)

  EXAMPLES
    # Start the hub server
    polpo server

    # Start the hub on a custom port
    polpo server --port 8080

    # Register a terminal Claude Code instance
    polpo agent --name "Backend refactor" --type terminal

    # Register a VS Code instance
    polpo agent --name "Frontend UI" --type vscode

  MOBILE ACCESS
    Once the server is running, open http://<your-computer-ip>:7890
    on your phone's browser (must be on the same network).
`);
}

async function runServer() {
  const { createServer } = require('../src/server/index');
  const server = createServer({
    port: parseInt(flags.port) || 7890,
    host: flags.host || '0.0.0.0',
    verbose: !!flags.verbose,
  });

  await server.start();

  // Print local network addresses for convenience
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
      console.log('  📱 Open on your phone:');
      const port = parseInt(flags.port) || 7890;
      addresses.forEach((addr) => {
        console.log(`     http://${addr}:${port}`);
      });
      console.log('');
    }
  } catch (e) {
    // not critical
  }

  process.on('SIGINT', async () => {
    console.log('\n  Shutting down...');
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

switch (command) {
  case 'server':
    runServer().catch((err) => {
      console.error('Failed to start server:', err.message);
      process.exit(1);
    });
    break;

  case 'agent':
    runAgent().catch((err) => {
      console.error('Failed to start agent:', err.message);
      process.exit(1);
    });
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
