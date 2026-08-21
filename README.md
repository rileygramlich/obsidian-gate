# Obsidian Agent Connector

**An MCP server that lets any AI agent read, search, write, and connect notes in your Obsidian vault.**

```bash
npx obsidian-agent-connector init   # point at your vault
npx obsidian-agent-connector        # dashboard on :3100
```

Claude Code, Codex, Cursor, Copilot — one line of config and your vault becomes an agent-accessible workspace. Runs entirely on your machine. No cloud, no database, no sync.

[![npm](https://img.shields.io/npm/v/obsidian-agent-connector)](https://www.npmjs.com/package/obsidian-agent-connector) [![License: MIT](https://img.shields.io/badge/License-MIT-purple)](LICENSE)

---

## Why

Obsidian is your second brain. Your AI agents should be able to use it.

The MCP ecosystem is exploding in 2026 — developers want to plug their vaults into agents for:

- **Daily standups** — "What did I work on yesterday?" → agent reads the daily note
- **Context gathering** — "Read my notes about project X before helping me code"
- **Knowledge synthesis** — "Search my vault for everything on Kubernetes and summarize"
- **Note taking** — "Save this debugging session to my vault as a new note"
- **Cross-linking** — "Link my meeting notes to the related project notes"

Before this, you had to build your own MCP server or pipe files manually. Now it's `npx` away.

## Tools

| Tool | What it does |
|------|-------------|
| `list_notes(path?)` | List notes and folders in a vault folder |
| `read_note(path)` | Full content plus parsed frontmatter |
| `search_notes(query, limit?)` | Ranked full-text search with line snippets |
| `create_note(path, content, frontmatter?)` | New note, vault frontmatter template applied |
| `update_note(path, content, mode?)` | Overwrite (or `append`) a note |
| `get_backlinks(path)` | Every note linking here via `[[wikilink]]` or `.md` link |
| `get_tags()` | All tags — frontmatter and inline — with counts |
| `get_daily_note(date?)` | Get or create the daily note (accepts `today`, `yesterday`, `-1`, ISO date) |
| `create_link(from, to, label?)` | Add a `[[wikilink]]` under `## Related` |

Notes are also exposed as MCP resources: `obsidian://{vault}/{path}`.

## Quick Start

### 1. Install & configure

```bash
npx obsidian-agent-connector init
```

Follow the prompts:
- Your vault path → `/home/user/Obsidian/MyVault`
- Vault name → `Personal`
- Agent name → `Claude Code`

You'll get an API key on completion. Save it — it's shown once.

### 2. Connect your agent

**Claude Code** — add to your MCP config:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["obsidian-agent-connector", "--mcp"]
    }
  }
}
```

**Or any MCP client** over HTTP:

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

### 3. Start the dashboard

```bash
npx obsidian-agent-connector
# → Dashboard at http://localhost:3100/dashboard
# → MCP over HTTP at http://localhost:3100/mcp
# → MCP over stdio: npx obsidian-agent-connector --mcp
```

### 4. Run a health check

```bash
npx obsidian-agent-connector doctor
```

Verifies vault access, all 9 MCP tools, and your license status.

## CLI Reference

| Command | What it does |
|---------|-------------|
| `init` | Interactive setup wizard |
| `serve` (default) | Dashboard + HTTP endpoint |
| `--mcp` | Run as MCP server over stdio |
| `doctor` | Verify vault, tools, and license |
| `keys list` | Show agent connections |
| `keys new <name>` | Create a new API key |
| `keys rotate <id>` | Rotate a key |
| `keys revoke <id>` | Revoke a key |
| `vault list` | Show configured vaults |
| `vault add <name> <path>` | Add a vault |
| `vault remove <name>` | Remove a vault |
| `license status` | Show your plan & usage |
| `license set <key>` | Activate a license key |
| `activity` | Recent agent activity log |
| `tools` | Print MCP tool definitions |

## Pricing

| Tier | Price | What you get |
|------|-------|-------------|
| **Free** | $0 | 50 queries/month, 1 vault, 1 agent connection |
| **Personal** | $19/mo | Unlimited queries, up to 3 vaults, unlimited agents |
| **Team** | $49/mo | Everything in Personal, 5 vaults, shared config |

14-day free trial on paid plans — no risk. Cancel anytime.

## Architecture

```
┌────────────┐     ┌──────────────────────┐     ┌──────────────┐
│ AI Agent   │────▶│  obsidian-agent-      │────▶│  Obsidian    │
│ (Claude,   │◀────│  connector            │◀────│  Vault       │
│  Codex,    │     │                      │     │  (filesystem) │
│  Cursor)   │     │  ┌─────┐  ┌───────┐  │     └──────────────┘
└────────────┘     │  │MCP  │  │Web    │  │
                   │  │stdio│  │Dshbrd │  │
                   │  └─────┘  └───────┘  │
                   └──────────────────────┘
```

- **Every byte is local** — no cloud, no servers, no sync
- **Config lives in** `~/.obsidian-agent/config.json` (mode 0600)
- **API keys are local secrets** — you own the whole stack
- **Activity log** — JSONL file tracks every agent action

## What This Is Not

This is NOT an Obsidian plugin. It's a standalone MCP server that runs alongside Obsidian, not inside it. A community plugin for one-click install is planned for v2.

This is NOT a sync engine. It reads and writes to your vault directory directly. Obsidian's own sync handles the rest.

This is NOT a note editor. The dashboard shows agent activity and status — it doesn't let you edit notes. Obsidian is better at that.

## Development

```bash
git clone https://github.com/rileygramlich/obsidian-agent-connector.git
cd obsidian-agent-connector
npm install
npm run build     # compile TypeScript → dist/
npm run dev       # hot-reload development
```

## Roadmap

- [x] MCP server with 9 tools
- [x] Local dashboard with activity logs
- [x] API key authentication
- [x] Stripe licensing (free + paid tiers)
- [ ] Obsidian community plugin (one-click install)
- [ ] Agent write-back with LLM-generated frontmatter
- [ ] Auto-tagging based on vault content
- [ ] "What changed today" agent digest

## License

MIT — build on it, ship it, sell it.