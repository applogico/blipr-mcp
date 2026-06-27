# @applogico/blipr-mcp

[![npm version](https://img.shields.io/npm/v/@applogico/blipr-mcp)](https://www.npmjs.com/package/@applogico/blipr-mcp)
[![CI](https://github.com/applogico/blipr-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/applogico/blipr-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@applogico/blipr-mcp)](./LICENSE)
[![Node](https://img.shields.io/node/v/@applogico/blipr-mcp)](https://nodejs.org)

An [MCP](https://modelcontextprotocol.io) server that lets AI agents send
**[Blipr](https://blipr.dev)** push alerts to your phone. Your agent finishes a
long task, breaks a build, needs approval, or gets stuck — and it pages you.

It's a thin stdio client: your MCP host (Claude Code, Cursor, …) launches it,
the agent calls a tool, and this process makes one outbound HTTPS `POST` to your
Blipr server. No inbound socket, nothing to host.

```
Claude Code ──stdio──► blipr-mcp ──POST /api/notify/<topic>──► blipr.dev ──APNs──► 📱
```

## Setup

No install needed — `npx` fetches it on demand. Point it at a Blipr server
(`blipr.dev` or your own self-hosted instance) and a default topic.

### Claude Code

```bash
claude mcp add blipr \
  --env BLIPR_URL=https://blipr.dev \
  --env BLIPR_TOPIC=agent-alerts \
  -- npx -y @applogico/blipr-mcp
```

### Cursor / Claude Desktop / any MCP host (JSON)

```jsonc
{
  "mcpServers": {
    "blipr": {
      "command": "npx",
      "args": ["-y", "@applogico/blipr-mcp"],
      "env": {
        "BLIPR_URL": "https://blipr.dev",
        "BLIPR_TOPIC": "agent-alerts"
      }
    }
  }
}
```

Then subscribe to the same topic (`agent-alerts`) in the Blipr iOS app, and
you'll get the agent's pushes on your phone.

## Configuration

| Env var       | Default             | Description                                            |
| ------------- | ------------------- | ------------------------------------------------------ |
| `BLIPR_URL`   | `https://blipr.dev` | Base URL of your Blipr server (hosted or self-hosted). |
| `BLIPR_TOPIC` | _(none)_            | Default topic used when a tool call omits one.         |

## Tools

### `send_alert`

Send a push notification. Parameters:

- `message` (required) — the alert body.
- `title` — short bold title.
- `topic` — overrides `BLIPR_TOPIC`.
- `priority` — `1` silent · `2` low · `3` default · `4` time-sensitive (breaks
  Focus) · `5` critical.
- `tags` — emoji shortcodes, e.g. `["warning"]`.
- `click` — URL opened when the notification is tapped.

### `send_critical`

A priority-5 page for things that genuinely can't wait. Bypasses silent/Focus
when the Blipr app has Apple's Critical Alerts entitlement enabled; otherwise
it's delivered as time-sensitive.

## Example prompts

> "Run the migration, and `send_alert` me when it's done — priority 4 if it
> fails."

> "If the nightly backup fails, `send_critical` me with the error — that one
> can't wait."

## Develop

```bash
npm install
npm run build      # → dist/index.js
npm test           # vitest: unit (publish) + in-memory MCP integration
BLIPR_URL=https://blipr.dev BLIPR_TOPIC=demo node dist/index.js   # stdio
```

## License

MIT © Applogico LLC. This is the open client adapter; the Blipr server is
distributed as a container image.
