# Vera

> Early-stage software. The current package version is 0.0.1, and the project
> is not yet a turn-key deployment.

Vera is an open-source, owner-operated workspace for running multiple AI
agents across private devices. It combines Space-based conversations,
independently hosted Agents, project Workspaces, approvals, files, and
long-term Memory behind one Gateway and a mobile-first web client.

## Architecture

- **Gateway** — the authoritative HTTP/SSE API and persistent state owner.
- **Agent daemon** — runs independently on the host that owns an Agent runtime
  and its Workspace.
- **Web client** — a mobile-first interface shared by desktop and phone
  browsers.
- **Private network** — production deployments are designed for Tailscale
  Serve in front of a loopback-only Gateway.

## Current capabilities

The current tree includes:

- private and group Spaces with streamed replies;
- Account identity separated from Agent runtime ownership;
- independently hosted Agent daemons with reconnect and execution leases;
- Codex CLI, OpenCode, and Ollama adapters;
- approvals, activity status, file attachments, and context sessions;
- Agent-scoped long-term Memory, retrieval, Digest, and Dream workflows;
- an owner-triggered, rollback-capable Gateway updater;
- a responsive web client and System, Agent, and Account management views.

## Requirements

- Node.js 20 or newer
- npm
- Provider-specific runtimes when using the corresponding Agent adapter
- Tailscale and systemd for the intended private VPS deployment model

## Local development

Install dependencies:

```sh
npm ci
```

Start the Gateway with disposable local data:

```sh
PORT=3210 \
VERA_DATA_PATH=/tmp/vera-dev \
VERA_ALLOW_LOOPBACK_DEVELOPMENT=true \
npm start
```

In another terminal, start the Vite development server:

```sh
npm run dev:web
```

Open the URL printed by Vite. The development server proxies `/api` to the
Gateway on port 3210. `VERA_ALLOW_LOOPBACK_DEVELOPMENT` is a development-only
bypass and is rejected when `NODE_ENV=production`.

## Verification

Run the unit and component test suite:

```sh
npm test
```

Build the web client:

```sh
npm run build:web
```

Run the production build, bundle budget, lazy-route, and timeline checks:

```sh
npm run analyze:web
```

Run the black-box Gateway HTTP/SSE acceptance suite:

```sh
node scripts/verify.mjs
```

Real provider smoke tests are opt-in and are not required by the default test
suite.

## Deployment status

Vera does not yet provide a supported one-command deployment.

`npm run setup` currently performs read-only host preflight and produces a
deployment plan. It stops at `planned` with `applied: false`; it does not
install packages, write deployment files, change services, configure
firewalls, or modify Tailscale.

The intended production topology is an owner-only private deployment: the
Gateway listens on loopback and is exposed only through Tailscale Serve. Do
not expose the Gateway directly to the public internet.

## Gateway updates

The System view can explicitly check for and apply a Gateway code update when
the root updater is installed and configured.

The updater prepares an isolated release, installs dependencies, runs tests,
builds and validates the web client, creates a cold data backup, switches
atomically, performs a health check, and restores the previous release and
data if startup fails.

It updates the Gateway only. It does not update Agent daemons, native clients,
Workspaces, or Memory Provider data.

## Security boundaries

- Vera is currently an owner-only system, not a multi-user service.
- The production Gateway must remain loopback-only behind Tailscale Serve.
- Public ingress, Funnel, public reverse proxies, and public Vera ports are
  outside the supported deployment model.
- Agent and Account credentials must remain outside the repository.
- Do not commit `~/.vera/secrets.json`, Account Keys, Agent Tokens, or session
  material.

## Project status

The web Gateway and core runtime are implemented and tested. Guided
deployment, native clients, the Extension system, and additional Space
surfaces remain under development.

This repository contains the public runtime code, tests, and deployment
artifacts. Internal design and planning documents are maintained separately
and are not part of the public default branch.

## License

Vera is released under the [MIT License](LICENSE).
