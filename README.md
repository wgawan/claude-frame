# Claude Frame

A zero-dependency web UI that lets non-technical users interact with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through a browser. No terminal required.

![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![Dependencies](https://img.shields.io/badge/dependencies-0-orange)

## What it does

- **Chat UI** -- Send prompts to Claude Code and see streaming results in the browser
- **Site preview** -- Embed any web app in a side-by-side iframe so users can see changes live
- **Context awareness** -- Claude automatically knows which page and modal the user is looking at
- **Branch management** -- Create branches, commit, and push without touching git
- **Session continuity** -- Conversations persist across prompts within the same session
- **Password protection** -- Simple auth to keep your instance private

## How it works

```
Browser (index.html)
  |
  |-- POST /api/run   --> spawns `claude` CLI with --output-format stream-json
  |-- GET  /api/stream --> SSE stream of Claude's output
  |
  +-- iframe ──> /__preview__/* ──> reverse proxy to your app
                   |
                   +-- injected bridge.js tracks SPA navigation + modal content
                       and posts it back to the parent frame
```

The server is a single Node.js file (~575 lines) with no dependencies. It proxies a target site through `/__preview__/` to make it same-origin with the chat UI, enabling cross-frame communication.

## Quick start

```bash
git clone https://github.com/wgawan/claude-frame.git && npm link -g ./claude-frame
```

Then go to any project directory and run:

```bash
cd ~/my-project
claude-frame
```

On first run, it will prompt you for a password and an optional preview URL. Settings are saved to `.env` in the current directory.

```
  Claude Frame — first-time setup

  Password for the web UI: ********
  URL to preview in iframe (optional, press Enter to skip): http://localhost:5173

  Saved to /home/you/my-project/.env

claude-frame running at http://localhost:3000
```

Open `http://localhost:3000` and enter your password.

## Prerequisites

- **Node.js >= 20**
- **Claude Code CLI** installed and authenticated (`claude` must be available on `PATH`)

## Configuration

All configuration is via environment variables or a `.env` file in the working directory. On first run, Claude Frame prompts for any missing required values and saves them.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_PASSWORD` | Yes | _(prompted)_ | Password for the web UI |
| `CLAUDE_PORT` | No | `3000` | Port to listen on |
| `CLAUDE_IFRAME_URL` | No | _(prompted)_ | URL of a site to embed in the preview panel |
| `CLAUDE_PROMPT_PREFIX` | No | _(prompted)_ | Prefix prepended to every prompt (e.g. "The user is non-technical") |

If `CLAUDE_IFRAME_URL` is not set, the UI runs in full-width chat mode with no preview panel.

## Features

### Live preview with context

When a preview URL is configured, Claude knows which page the user is viewing and what modals are open. Users can say things like "change the title on this page" or "fix this dialog" and Claude will find the right source code.

### Branch safety

On launch, if the working directory is on a protected branch (`main`, `master`, `development`, `develop`), the UI prompts the user to create a feature branch before making any changes. Direct commits to protected branches are blocked.

### Viewport switching

The preview panel has mobile (375px), tablet (768px), and desktop (full-width) viewport toggles for responsive testing.

### SPA navigation tracking

The reverse proxy injects a bridge script into proxied HTML that intercepts `pushState`, `replaceState`, and link clicks. This keeps the URL bar in sync and ensures all navigation stays within the `/__preview__/` prefix.

## Architecture

```
claude-frame/
  server.js                 # HTTP server: API routes, SSE streaming, reverse proxy
  index.html                # Single-page frontend (vanilla JS, no build step)
  claude-frame-bridge.js    # Standalone bridge script for manual inclusion
  package.json              # Project metadata (zero dependencies)
```

## Running as a global CLI

```bash
npm install -g .
claude-frame
```

Or link it during development:

```bash
npm link
claude-frame
```

## Security considerations

- **Password auth** uses a simple bearer token comparison. This is fine for local use or trusted networks. For public exposure, put it behind a reverse proxy with HTTPS and stronger auth.
- **SSE token in URL** -- the `EventSource` API does not support custom headers, so the auth token is passed as a `?token=` query parameter for streaming endpoints. This means the token may appear in server logs and browser history. Use HTTPS to prevent network sniffing.
- **Auth rate limiting** -- the `/api/auth` endpoint is rate-limited to 5 attempts per minute per IP to prevent brute-force attacks.
- **The preview proxy strips `X-Frame-Options` and `Content-Security-Policy` headers** from proxied responses to allow iframe embedding. This is by design but means the proxied site loses those protections within this context.
- **Prompt injection via proxied content** -- modal text scraped from the proxied iframe is included in prompts to Claude. A malicious page could craft modal content to influence Claude's behavior. The injected text is labelled as untrusted, but be aware of this when proxying sites you don't control.
- **`CLAUDE_PROMPT_PREFIX`** is treated as trusted operator input and injected into every prompt. Do not set it from user-controlled sources.
- **Git operations** (`commit`, `push`, `checkout`) execute on the server's filesystem. Only expose this to users you trust with write access to the repo.
- **Request body size** is capped at 1 MB to prevent abuse.
- **Branch names** are sanitized to prevent command injection.
- **`.env` parser** is minimal -- inline comments are not supported (e.g., `KEY=value # comment` will include `# comment` in the value).

## License

[MIT](LICENSE)
