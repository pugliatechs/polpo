# Security Policy

Polpo lets whoever reaches it drive coding agents on the host machine, so a vulnerability in it is often a way to run commands on that machine. Please report one privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue, pull request or discussion for a vulnerability before it is fixed.

Include, if you can:

- the polpo version or commit;
- how polpo was started (flags and `POLPO_*` environment variables);
- the steps or the code path, with files and lines;
- what an attacker gains, and who the attacker has to be (same machine, same network, any web page, internet).

## What to expect

- An acknowledgement within 7 days.
- A first assessment, and a fix plan for a confirmed issue, within 30 days.
- A GitHub security advisory when the fix is released, crediting the reporter unless they prefer otherwise.

## Supported versions

Fixes go into the latest release. There are no backports to older versions.

## Scope

The threat model, with what polpo defends against and what it deliberately trusts, is in [docs/security.md](docs/security.md). Behaviour that the threat model lists as trusted (for example, any program on the host when `--trust-localhost` is on) is not a vulnerability by itself, but a way around a stated defence is.
