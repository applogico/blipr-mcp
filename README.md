# @blipr/mcp

[![npm version](https://img.shields.io/npm/v/@blipr/mcp)](https://www.npmjs.com/package/@blipr/mcp)
[![CI](https://github.com/applogico/blipr-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/applogico/blipr-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@blipr/mcp)](./LICENSE)
[![Node](https://img.shields.io/node/v/@blipr/mcp)](https://nodejs.org)

> Previously published as `@applogico/blipr-mcp`. That package is deprecated;
> new releases ship as **`@blipr/mcp`**. Update your MCP config to
> `npx -y @blipr/mcp`.

An [MCP](https://modelcontextprotocol.io) server that lets AI agents send
**[Blipr](https://blipr.dev)** push notifications to your phone. It can also
**ask you a question and block until you answer**.

It's a thin stdio client: your MCP host (Claude Code, Cursor, …) launches it,
the agent calls a tool, and this process makes one outbound HTTPS `POST` to your
Blipr server. No inbound socket, nothing to host.

```
Claude Code ──stdio──► @blipr/mcp ──POST /blip/<topic>──► blipr.dev ──APNs──► 📱
```

## Setup

No install needed — `npx` fetches it on demand. Point it at a Blipr server
(`blipr.dev` or your own self-hosted instance).

### Claude Code

```bash
claude mcp add blipr \
  --env BLIPR_URL=https://blipr.dev \
  -- npx -y @blipr/mcp
```

### Cursor / Claude Desktop / any MCP host (JSON)

```jsonc
{
  "mcpServers": {
    "blipr": {
      "command": "npx",
      "args": ["-y", "@blipr/mcp"],
      "env": {
        "BLIPR_URL": "https://blipr.dev"
      }
    }
  }
}
```

### Pick a topic (per project, not global)

Every blip goes to a **topic**. The topic for a call is resolved in this order:

1. **`topic` tool argument** — the agent passes it on the call. Always wins.
2. **`.blipr-topic` file** — per-project default. Put the topic name on the
   first line of a `.blipr-topic` file in the project root; the server picks up
   the nearest one from its launch directory upward (`#` lines are comments).
3. **`BLIPR_TOPIC` env var**: global fallback. Every project on the machine
   without its own `.blipr-topic` file sends to this topic.

```bash
echo my-project-alerts > .blipr-topic
```

Then subscribe to the same topic (`my-project-alerts`) in the Blipr iOS app,
and you'll get the agent's pushes on your phone. On blipr.dev that subscribe,
made while signed in, is also what creates the topic, so do it before the
agent's first blip: publishing to a topic that does not exist returns 404. A
self-hosted server still creates the topic on the first publish.

## Configuration

| Setting                    | Default             | Description                                                                 |
| -------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `BLIPR_URL` (env)          | `https://blipr.dev` | Base URL of your Blipr server (hosted or self-hosted).                      |
| `.blipr-topic` (file)      | _(none)_            | Per-project default topic, nearest file from the launch directory upward.   |
| `BLIPR_TOPIC` (env)        | _(none)_            | Global fallback topic; lowest precedence (see "Pick a topic" above).        |
| `BLIPR_TOKEN` (env)        | _(none)_            | Token sent as `Authorization: Bearer`. An account token sends under your account's plan; a scoped token publishes to a protected topic. Nothing is sent when unset. |

## Tools

### `send_alert`

Send a push notification. Parameters:

- `message` (required): the message body.
- `title` — short bold title.
- `topic`: topic to publish to (falls back to
  `.blipr-topic`, then `BLIPR_TOPIC`).
- `priority` — `1` silent · `2` low · `3` default · `4` high (plays a sound,
  respects Focus) · `5` Time Sensitive with Blipr Pro (surfaces through Focus);
  on the free plan `5` is delivered as `4`, never refused.
- `tags` — emoji shortcodes, e.g. `["warning"]`.
- `click` — URL opened when the notification is tapped.
- `markdown`: render the body as Markdown (bold, italics, links, code). Off by default.

### `send_critical`

A priority 5 message. Takes `message`
(required), `title`, `topic` and `markdown`. With Blipr Pro it is delivered as
Time Sensitive, so it surfaces through Focus and Do Not Disturb. On the free
plan it is delivered as priority 4, never refused. The plan is the sender's:
set `BLIPR_TOKEN` to an account token so it sends as your Pro account.

### `ask`: yes/no, multiple choice or open question (blocks)

Send a **yes/no, multiple-choice or open question** to your phone and **block
until you answer**, then return the answer.

- `message` (required): the question.
- `title`: short bold title.
- `topic`: topic to publish to (falls back to `.blipr-topic`, then `BLIPR_TOPIC`).
- `priority`: defaults to `4` (high).
- `tags`: emoji shortcodes, e.g. `["question"]`.
- `markdown`: render the body as Markdown (bold, italics, links, code). Off by default.
- `options`: 2 to 5 distinct choices. Makes it a multiple-choice question; omit for yes/no.
- `open_question`: set to `true` to type the answer yourself, up to 120
  characters.
- `timeout_seconds`: how long to wait for your answer (default `120`).

Every kind of question is free on every plan; an answer counts toward your
daily replies.

Returns `{ responded: true, value, message_id, topic }`. `value` is `"yes"` or
`"no"`, the option you tapped exactly as sent, or the text you typed (one line
of at most 120 characters). With no answer in time it returns
`{ responded: false, reason: "timeout", message_id, topic }`. After a timeout
(or if your MCP client cancels the call) you can still answer: `check_reply`
with the returned `message_id` picks it up.

Under the hood it publishes with `reply: "binary"` (`reply: "choice"` with
`options`, `reply: "text"` with `open_question`), captures the message `id`
from the publish response, then long-polls
`GET /blip/<topic>/<id>/reply?wait=…` until you answer or the timeout
budget runs out.

### `request_ack`: acknowledgement (blocks)

Send a message with an **Acknowledge** button and **block until you tap it**.
Same parameters as `ask` except `options` and `open_question`; publishes with
`reply: "ack"`.

Returns `{ responded, message_id, topic }` plus `replied_at` when acked, or
`{ responded: false, reason: "timeout", … }`. After a timeout, `check_reply`
with the returned `message_id` picks up a later ack.

### `check_reply`: look up an earlier ask or request_ack

Look up whether you've replied to an earlier `ask` or `request_ack`, including
one that timed out or that your MCP client cancelled. Takes the `message_id`
(and `topic`) it returned; non-blocking by default, or set `wait_seconds` to
briefly long-poll (up to `300` seconds). Returns `{ responded, value?, replied_at? }` (`value` is
`"yes"` / `"no"` / `"ack"`, the chosen option, or the text you typed).

## Example prompts

> "Run the migration, and `send_alert` me when it's done."

> "`ask` me before you run the migration."

> "`ask` me as an open question what to call the release."

## Develop

```bash
npm install
npm run build      # → dist/index.js
npm test           # vitest: unit (publish, config) + in-memory MCP integration
BLIPR_URL=https://blipr.dev BLIPR_TOPIC=demo node dist/index.js   # stdio
```

## License

MIT © Applogico LLC. This is the open client adapter; the Blipr server is
distributed as a container image.
