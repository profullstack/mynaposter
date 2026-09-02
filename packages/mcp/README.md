# @profullstack/myna-mcp

An MCP server for [myna](https://mynaposter.com). Lets an agent see which social
accounts are connected, draft, preview, post, schedule and read back, across 25
networks.

```json
{
  "mcpServers": {
    "myna": { "command": "bunx", "args": ["@profullstack/myna-mcp"] }
  }
}
```

It reads the local myna vault, so the agent can post as you without ever being
handed a credential.

## Tools

| Tool | What it does |
|---|---|
| `myna_accounts` | Connected accounts and their ids. No credentials. |
| `myna_networks` | Every supported network, how it logs in, its limit. |
| `myna_preview` | What each target would receive. Sends nothing. |
| `myna_post` | Publish now. |
| `myna_schedule` | Queue for later. |
| `myna_queue` | Pending scheduled posts. |
| `myna_cancel` | Remove one from the queue. |
| `myna_history` | What was sent, and what failed and why. |
| `myna_draft` | Draft from a topic or a URL. Publishes nothing. |
| `myna_timeline` | Read a home timeline. |

## Two deliberate omissions

**There is no login tool.** Connecting an account means typing a password or
completing a browser OAuth flow. That belongs to a person at a keyboard, so it
stays in `myna login <network>`.

**`myna_post` is not reversible.** It publishes publicly and immediately, and
several networks have no delete API at all. Its description says so, and
`myna_preview` and `dry_run` exist so an agent can check the targets and the
per-network tailoring before committing.

MIT.
