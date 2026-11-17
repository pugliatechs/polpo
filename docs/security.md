# Security model

This page says what polpo protects, who it defends against, where requests come in, and what it deliberately trusts. Check a change against it: a change that moves a default, adds an entry point or widens a trust assumption needs a review of this page as well as of the code. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is at stake

Polpo drives coding agents (Claude, Codex, Gemini, OpenCode, Pi, Goose) on the host with the operator's own permissions. Whoever controls polpo can:

- run commands on the host through an agent: create a session in any existing directory, turn on auto-approve, send a prompt;
- read what the agents read and say: transcripts of every session on the host, tool calls, file contents, secrets that pass through them;
- move files in and out (uploads, the session outbox, gateway artifacts).

A developer machine usually also holds SSH keys, cloud tokens and `.env` files. So every defence below protects the whole host, not only polpo.

## Who polpo defends against

| Attacker | Example | Defence |
|---|---|---|
| Someone on the same network | café, hotel or event Wi-Fi; a shared office LAN | Loopback by default; refusal to listen on a network address without auth; token, PIN or TOTP |
| Any web page the operator opens | a page that calls `http://localhost:7890`, or uses DNS rebinding | Origin check; `Host` allow-list; `SameSite` cookie; CSP and `frame-ancestors 'none'` |
| Anyone on the internet, through a tunnel | a leaked or guessed tunnel URL | Auth on by default with `--tunnel`; single-use QR token; PIN or TOTP; rate limits |
| A gateway caller with a stolen key | the `/v1` key copied from a bot's config | Separate key from the dashboard; per-key rate limits; path checks on every file route; tasks in Claude's `auto` mode |
| Content the agents read | a README or web page that tries prompt injection | Out of polpo's reach in general; plans and questions always go to a human, and gateway tasks fail on what `auto` mode still asks about |

## Entry points

| Entry point | Who uses it | Auth |
|---|---|---|
| Dashboard pages | the phone or desktop browser | the single-use login token from the QR link, then PIN or TOTP when enabled, then a session cookie; none in no-auth mode |
| `/api/*` | the dashboard; agents and scripts | session cookie, or the agent token as a Bearer header |
| WebSocket `role=dashboard` | the dashboard | session cookie or token |
| WebSocket `role=agent` | polpo's own sessions, hooks, bridges | the agent token, as an `Authorization: Bearer` header |
| `/api/permission-request` | the permission server inside each Claude session | Bearer token |
| `/v1/*` | external software (bots, CI, scripts) | the gateway Bearer key, always |
| Tunnels (cloudflared, ngrok, localtunnel, ssh) | the phone from anywhere | the same auth as the dashboard |
| Skills install (`npx skills add`) | the dashboard | the dashboard's auth |

Every HTTP route and the WebSocket upgrade first pass the `Host` allow-list (`src/server/host-guard.js`). Browser requests to `/api` and WebSocket upgrades also pass the Origin check.

## Trust assumptions

These are deliberate. Each says what an operator accepts by choosing it.

- **Loopback is the default.** Polpo listens on `127.0.0.1` unless `--host` says otherwise. Every program and account on the host can reach it there, so auth matters on loopback too, except with `--trust-localhost`.
- **`--trust-localhost` trusts the whole host.** A request from a loopback address, with no `X-Forwarded-For` and a loopback `Host`, skips auth. Any local program or account gets full control. It is refused with `--tunnel ssh`, whose raw TCP forward makes internet traffic look local.
- **`--auth none` on a network address trusts the whole network.** It is refused unless asked for by name, and polpo prints a warning when it is.
- **IP addresses pass the `Host` check.** A page cannot make the browser send `Host: <ip>` except by calling that address directly, and the Origin check refuses that request.
- **The tunnel's name passes while it is current.** A rotated quick-tunnel name stops passing as soon as a new one replaces it.
- **Two tokens, one for links and one for agents.** The login token goes in the QR code and phone links, where it can leak (browser history, screenshots, the tunnel provider, which terminates TLS). It only opens the dashboard page, once, and with PIN or TOTP on it leads only to that step. The agent token opens the API and the WebSocket, is never put in a link, and is refused in a URL.
- **The gateway key is a master key.** Any holder can search every session on the host (see `docs/gateway.md`).

## Known gaps

Open items, so a reviewer does not rediscover them as new:

- **Skills install** runs `npx skills add <package> -g -y` with no preview, no confirmation and an unpinned `skills` CLI. A skill is text the agent follows as instructions.
- **localtunnel** 2.0.2 is unmaintained and pulls `axios` 0.21.4, which has known advisories. Auto-detect falls back to it (and to the loca.lt service) when cloudflared is missing.
- **`uuid` 9** has an advisory for `v3`, `v5` and `v6` with a caller-supplied buffer. Polpo only calls `v4()` without one, so it is not affected.

## Checks

- `npm test` covers the defences above: `test/host-guard.test.js`, `test/server-network-exposure.test.js` (a real server: bind default, startup refusals, `Host` and Origin checks on HTTP and WebSocket, the tunnel name, `--trust-localhost`), `test/auth.test.js` (including the separation of the login token from the agent token).
- CI runs `npm audit` on the runtime dependencies and fails on a critical advisory. Dependabot proposes dependency and GitHub Actions updates every week.
- CodeQL scans the JavaScript on every push and pull request to `main`, and weekly.
- Before each minor release, read this page against the code: every entry point, every default, every trust assumption. A review of each change does not catch a wrong default that was there before it.
