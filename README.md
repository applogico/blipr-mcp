# @applogico/blipr-mcp

[![npm version](https://img.shields.io/npm/v/@applogico/blipr-mcp)](https://www.npmjs.com/package/@applogico/blipr-mcp)
[![CI](https://github.com/applogico/blipr-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/applogico/blipr-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@applogico/blipr-mcp)](./LICENSE)
[![Node](https://img.shields.io/node/v/@applogico/blipr-mcp)](https://nodejs.org)

An [MCP](https://modelcontextprotocol.io) server that lets AI agents send
**[Blipr](https://blipr.dev)** push alerts to your phone. Your agent finishes a
long task, breaks a build, needs approval, or gets stuck — and it pages you. It
can also **ask you a question and block until you answer**, for human-in-the-loop
approval gates.

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

### `ask` — human-in-the-loop yes/no (blocks)

Send a **yes/no question** to your phone and **block until you tap an answer**,
then return it. This is an approval gate: the agent calls it before doing
something consequential or irreversible and waits for your decision instead of
guessing.

- `message` (required) — the yes/no question.
- `title` — short bold title.
- `topic` — overrides `BLIPR_TOPIC`.
- `priority` — defaults to `4` (time-sensitive) since it needs an answer.
- `tags` — emoji shortcodes, e.g. `["question"]`.
- `timeout_seconds` — how long to wait for your answer (default `120`).

Returns `{ answered: true, value: "yes" | "no" }`, or
`{ answered: false, reason: "timeout" }` if you don't reply in time — treat a
timeout as **not approved**.

Under the hood it publishes with `reply: "binary"`, captures the message `id`
from the publish response, then long-polls
`GET /api/notify/<topic>/<id>/reply?wait=…` until you answer or the timeout
budget runs out.

### `request_ack` — require acknowledgement (blocks)

Send a message that you must **acknowledge**, and **block until you tap
"Acknowledge"**. Use it when the human has to see and confirm something before
the agent continues. Same parameters as `ask`; publishes with `reply: "ack"`.

Returns `{ acknowledged: true, replied_at }`, or
`{ acknowledged: false, reason: "timeout" }`.

## Example prompts

> "Run the migration, and `send_alert` me when it's done — priority 4 if it
> fails."

> "If the nightly backup fails, `send_critical` me with the error — that one
> can't wait."

> "Before you `DROP` the production table, `ask` me to approve it — only proceed
> if I answer yes."

A concrete approval-gate flow:

```
Agent: about to delete the prod `events` table → calls
       ask("Delete prod `events` table (12M rows)? This cannot be undone.")
        … blocks; your phone buzzes …
You:   tap "No"
Agent: ask returns { answered: true, value: "no" } → aborts the deletion.
```

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
