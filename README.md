# @blipr/mcp

[![npm version](https://img.shields.io/npm/v/@blipr/mcp)](https://www.npmjs.com/package/@blipr/mcp)
[![CI](https://github.com/applogico/blipr-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/applogico/blipr-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@blipr/mcp)](./LICENSE)
[![Node](https://img.shields.io/node/v/@blipr/mcp)](https://nodejs.org)

> Previously published as `@applogico/blipr-mcp`. That package is deprecated;
> new releases ship as **`@blipr/mcp`**. Update your MCP config to
> `npx -y @blipr/mcp`.

An [MCP](https://modelcontextprotocol.io) server that lets AI agents send
**[Blipr](https://blipr.dev)** push alerts to your phone. Your agent finishes a
long task, breaks a build, needs approval, or gets stuck — and it pages you. It
can also **ask you a question and block until you answer**, for human-in-the-loop
approval gates.

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

Every blip goes to a **topic**, and each project should use its own, so alerts
from different projects land separately on your phone. The topic for a call is
resolved in this order:

1. **`topic` tool argument** — the agent passes it on the call. Always wins.
2. **`.blipr-topic` file** — per-project default. Put the topic name on the
   first line of a `.blipr-topic` file in the project root; the server picks up
   the nearest one from its launch directory upward (`#` lines are comments).
3. **`BLIPR_TOPIC` env var** — global fallback, kept for backward
   compatibility. Avoid it when one machine hosts several projects: a global
   default makes every project ping the same topic.

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

- `message` (required) — the alert body.
- `title` — short bold title.
- `topic` — topic to publish to; pass it explicitly (falls back to
  `.blipr-topic`, then `BLIPR_TOPIC`).
- `priority` — `1` silent · `2` low · `3` default · `4` high (plays a sound,
  respects Focus) · `5` Time Sensitive with Blipr Pro (surfaces through Focus);
  on the free plan `5` is delivered as `4`, never refused.
- `tags` — emoji shortcodes, e.g. `["warning"]`.
- `click` — URL opened when the notification is tapped.
- `markdown`: render the body as Markdown (bold, italics, links, code). Off by default.

### `send_critical`

A priority 5 message for things that genuinely can't wait. Takes `message`
(required), `title`, `topic` and `markdown`. With Blipr Pro it is delivered as
Time Sensitive, so it surfaces through Focus and Do Not Disturb. On the free
plan it is delivered as priority 4, never refused. The plan is the sender's:
set `BLIPR_TOKEN` to an account token so it sends as your Pro account.

### `ask`: human-in-the-loop yes/no, multiple choice or open question (blocks)

Send a **yes/no, multiple-choice or open question** to your phone and **block until you answer**,
then return it. As a yes/no question it is an approval gate: the agent calls it before doing
something consequential or irreversible and waits for your decision instead of
guessing. When a tap is not enough, an open question lets you type the answer
yourself, up to 120 characters.

- `message` (required): the question.
- `title` — short bold title.
- `topic` — topic to publish to; pass it explicitly (falls back to
  `.blipr-topic`, then `BLIPR_TOPIC`).
- `priority` — defaults to `4` (high) since it needs an answer.
- `tags` — emoji shortcodes, e.g. `["question"]`.
- `markdown`: render the body as Markdown (bold, italics, links, code). Off by default.
- `options`: 2 to 5 distinct choices. Makes it a multiple-choice question; omit for yes/no.
  Free on every plan; an answer counts toward your daily replies like any other.
- `open_question`: set to `true` to get a typed answer of up to 120 characters
  instead of a tap. Cannot be combined with `options`. Free on every plan; an answer counts toward your daily replies.
- `timeout_seconds` — how long to wait for your answer (default `120`).

Returns `{ responded, approved, value, message_id, topic }`. **Branch on
`approved`** — it is `true` **only** when you tapped Yes, and `false` on No, a
timeout, or an error, so a refusal or non-answer can never be misread as a
go-ahead. On a timeout you get
`{ responded: false, approved: false, reason: "timeout", message_id, topic }`. If
it times out (or your MCP client cancels the call), you can still answer
later: pass the returned `message_id` to `check_reply` to pick it up.

With `options`, it returns `{ responded, value, message_id, topic }` with no
`approved`. `value` is the option you tapped, exactly as sent.

With `open_question`, it returns the same shape with no `approved`. `value` is
what you typed, trimmed to a single line of at most 120 characters.

Under the hood it publishes with `reply: "binary"` (`reply: "choice"` with
`options`, `reply: "text"` with `open_question`), captures the message `id`
from the publish response, then long-polls
`GET /blip/<topic>/<id>/reply?wait=…` until you answer or the timeout
budget runs out.

### `request_ack` — require acknowledgement (blocks)

Send a message that you must **acknowledge**, and **block until you tap
"Acknowledge"**. Use it when the human has to see and confirm something before
the agent continues. Same parameters as `ask` except `options` and `open_question`; publishes with `reply: "ack"`.

Returns `{ responded, message_id, topic }` plus `replied_at` when acked, or
`{ responded: false, reason: "timeout", … }`. As with `ask`, on a timeout you can
resume later with `check_reply` and the returned `message_id`.

### `check_reply` — resume / poll an earlier ask or request_ack

Look up whether you've replied to an earlier `ask`/`request_ack` — handy if the
blocking call timed out or your MCP client cancelled it. Pass the `message_id`
(and `topic`) it returned; non-blocking by default, or set `wait_seconds` to
briefly long-poll (up to `300` seconds). Returns `{ responded, value?, replied_at? }` (`value` is
`"yes"` / `"no"` / `"ack"`, the chosen option, or the text you typed).

## Example prompts

> "Run the migration, and `send_alert` me when it's done — priority 4 if it
> fails."

> "If the nightly backup fails, `send_critical` me with the error — that one
> can't wait."

> "Before you `DROP` the production table, `ask` me to approve it — only proceed
> if I answer yes."

> "If you're unsure what to name the release, `ask` me as an open question and
> use what I type."

A concrete approval-gate flow:

```
Agent: about to delete the prod `events` table → calls
       ask("Delete prod `events` table (12M rows)? This cannot be undone.")
        … blocks; your phone buzzes …
You:   tap "No"
Agent: ask returns { responded: true, approved: false, value: "no" } → aborts the deletion.
```

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
