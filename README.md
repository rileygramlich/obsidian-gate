# obsidian-agent

**An MCP server that lets any AI agent read, search, write, and connect notes in your Obsidian vault.**

Claude Code, Codex, Cursor, or your own agent — one config line and your vault becomes an
agent-accessible workspace. Runs locally against the filesystem. No cloud, no database, no sync.

```bash
npx obsidian-agent init   # point it at your vault, get an API key
npx obsidian-agent        # dashboard + HTTP endpoint on :3100
```

## Tools

| Tool | What it does |
|---|---|
| `list_notes(path?)` | List notes and folders in a vault folder |
| `read_note(path)` | Full content plus parsed frontmatter |
| `search_notes(query, limit?)` | Ranked full-text search with line snippets |
| `create_note(path, content, frontmatter?)` | New note, vault frontmatter template applied |
| `update_note(path, content, mode?)` | Overwrite (or `append`) a note |
| `get_backlinks(path)` | Every note linking here via `[[wikilink]]` or `.md` link |
| `get_tags()` | All tags — frontmatter and inline — with counts |
| `get_daily_note(date?)` | Get or create the daily note (`today`, `yesterday`, `-1`, ISO date) |
| `create_link(from, to, label?)` | Add a `[[wikilink]]` under `## Related` |

Notes are also exposed as MCP resources: `obsidian://{vault}/{path}`.

## Connecting an agent

**stdio** (recommended — the client launches the server):

```json
{ "mcpServers": { "obsidian": { "command": "npx", "args": ["obsidian-agent", "--mcp"] } } }
```

**HTTP** (one server, several agents, key-protected):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://localhost:3100/mcp",
      "headers": { "Authorization": "Bearer sk-your-key" }
    }
  }
}
```

Claude Code one-liner: `claude mcp add obsidian -- npx obsidian-agent --mcp`.
More clients and example prompts: [`examples/claude-code-config.md`](examples/claude-code-config.md).

## CLI

```
obsidian-agent                 start dashboard + MCP HTTP endpoint (default)
obsidian-agent --mcp           speak MCP over stdio
obsidian-agent init            setup wizard: vault, key, MCP config
obsidian-agent doctor          verify vault access and every tool
obsidian-agent keys list|new <name>|rotate <id>|revoke <id>
obsidian-agent vault list|add <name> <path>|remove <name>
obsidian-agent license status|set <key>
obsidian-agent activity -n 20  recent agent activity
obsidian-agent tools           print the MCP tool definitions
```

## Web pages

Served from the local server on port 3100:

- `/` — landing page
- `/install` — setup guide, live connection test, license activation
- `/dashboard` — vault status, agent activity feed, connected agents, usage
- `/settings` — keys, permissions, vaults, server settings, subscription

## Config

`~/.obsidian-agent/config.json` (mode 0600) is the whole configuration:

```json
{
  "version": 1,
  "vaults": [
    {
      "name": "Personal",
      "path": "/home/you/Obsidian/Personal",
      "daily_notes_path": "01-Daily/",
      "frontmatter_template": { "created": "{{date}}", "tags": [] }
    }
  ],
  "agent_connections": [
    {
      "key": "sk-abc123",
      "name": "Claude Code",
      "vault": "Personal",
      "permissions": ["read", "write", "search"],
      "last_used": "2026-08-21T16:00:00Z"
    }
  ],
  "settings": { "port": 3100, "log_level": "info", "max_search_results": 50 }
}
```

Env overrides (see `.env.example`): `OBSIDIAN_AGENT_HOME`, `OBSIDIAN_VAULT_PATH`, `PORT`,
`OBSIDIAN_AGENT_LICENSE`.

## Auth

- `/mcp` **always** requires a valid API key (`Authorization: Bearer` or `x-api-key`); anything
  else gets a 401.
- `/api/*` accepts a key, or an unauthenticated request from this machine's loopback interface —
  that's how the local dashboard reads its own API without putting a key in the browser.
- stdio needs no key: whoever launched the process already has your filesystem.
- Permissions are per connection: `read`, `write`, `search`. A tool call outside a connection's
  permissions is rejected.

## Pricing

| Tier | Price | Limits |
|---|---|---|
| Free | $0 | 50 queries/month, 1 vault, 1 agent |
| Personal | $19/mo | Unlimited queries, 3 vaults, unlimited agents |
| Team | $49/mo | Unlimited queries, 3 vaults, 5 agents, shared config |

14-day trial on both paid plans. Activate with `obsidian-agent license set <key>` or on `/settings`.
The license is checked on startup and cached for 24h, so a network blip never blocks your vault.
Stripe credentials (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_PERSONAL`, `STRIPE_PRICE_TEAM`) are only
needed to *sell* the product — end users never set them.

## Behaviour worth knowing

- Last write wins. `update_note` overwrites; there's no version history or conflict resolution.
- Paths are vault-relative and can't escape the vault; `.obsidian`, `.git` and `.trash` are skipped.
- `.md` is appended automatically when a path has no extension.
- Frontmatter parsing covers Obsidian's flat YAML (scalars, `[a, b]`, `- item` lists).

## Development

```bash
npm install
npm run build        # tsc → dist/
npm run dev          # tsx src/index.ts
npm run dev -- doctor
npx @modelcontextprotocol/inspector npx obsidian-agent --mcp
```

MIT.
