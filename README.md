# Obsidian Gate

**An MCP server that opens your Obsidian vault to any AI agent.**

```bash
npx obsidian-gate init     # point at your vault
npx obsidian-gate          # dashboard on :3100
```

[![npm](https://img.shields.io/npm/v/obsidian-gate)](https://www.npmjs.com/package/obsidian-gate) [![License: MIT](https://img.shields.io/badge/License-MIT-purple)](LICENSE)

---

Your Obsidian vault is your second brain. Your AI agents should be able to use it.

Claude Code, Codex, Cursor — one line of config and your vault becomes an agent-accessible workspace. Every note, every link, every tag. All local, all yours, no cloud.

---

## Try It

```bash
# One command to set up
npx obsidian-gate init

# Start the dashboard
npx obsidian-gate
# → http://localhost:3100/dashboard
```

That's it. Your agents can now read, search, and write to your vault.

---

## Quick Start

### 1. Point at your vault

```bash
npx obsidian-gate init
```

You'll be asked for your vault path. Paste it in, get an API key back.

### 2. Connect your agent

**Claude Code** — drop this into your MCP config:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["obsidian-gate", "--mcp"]
    }
  }
}
```

**Any MCP client** over HTTP:

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

### 3. Ask your agent

Try these:

| Prompt | What happens |
|--------|-------------|
| "What did I work on yesterday?" | Agent reads your daily note |
| "Search my vault for Kubernetes notes" | Full-text search across every note |
| "Save this debugging session to my vault" | Creates a new note with frontmatter |
| "Link my meeting notes to the project notes" | Adds a `[[wikilink]]` |

---

## Tools — 9 Operations

| Tool | What it does |
|------|-------------|
| `list_notes(path?)` | List notes and folders in a vault folder |
| `read_note(path)` | Full note content + parsed frontmatter |
| `search_notes(query, limit?)` | Full-text search with ranked results and snippets |
| `create_note(path, content, frontmatter?)` | New note with vault template frontmatter |
| `update_note(path, content, mode?)` | Overwrite or append to a note |
| `get_backlinks(path)` | Every note linking here via `[[wikilink]]` |
| `get_tags()` | All tags — frontmatter and inline — with counts |
| `get_daily_note(date?)` | Get or create the daily note (today, yesterday, -1, ISO) |
| `create_link(from, to, label?)` | Add a `[[wikilink]]` under `## Related` |

Notes are also exposed as MCP resources: `obsidian://{vault}/{path}`.

---

## CLI

| Command | What it does |
|---------|-------------|
| `init` | Interactive setup wizard |
| `serve` (default) | Dashboard + MCP HTTP on :3100 |
| `--mcp` | Run as MCP server over stdio |
| `doctor` | Verify vault access and all 9 tools |
| `keys list` | Show agent connections |
| `keys new <name>` | Create a new API key |
| `keys rotate <id>` | Rotate a key |
| `keys revoke <id>` | Revoke a key |
| `vault list` | Configured vaults |
| `vault add <name> <path>` | Add a vault |
| `vault remove <name>` | Remove a vault |
| `license status` | Your plan and usage |
| `license set <key>` | Activate a license key |
| `activity` | Agent activity log |

---

## Pricing

| Tier | Price | What you get |
|------|-------|-------------|
| **Free** | $0 | 50 queries/month, 1 vault, 1 agent |
| **Personal** | $19/mo | Unlimited queries, 3 vaults, unlimited agents |
| **Team** | $49/mo | Everything in Personal + shared config, priority support |

14-day free trial on paid plans. No risk. Cancel anytime.

---

## Architecture

```
┌────────────┐     ┌──────────────────────┐     ┌──────────────┐
│ AI Agent   │────▶│   obsidian-gate      │────▶│  Obsidian    │
│ (Claude,   │◀────│   (MCP Server)       │◀────│  Vault       │
│  Codex,    │     │                      │     │  (files)     │
│  Cursor)   │     │  stdio ─ dashboard   │     └──────────────┘
└────────────┘     └──────────────────────┘
```

- **All local.** Every byte lives on your machine. No cloud, no servers, no sync.
- **Config in** `~/.obsidian-gate/config.json` (mode 0600)
- **API keys** are local secrets. You own the stack.
- **Activity log** tracks every agent action in JSONL.

---

## What Gate Is Not

- ❌ Not an Obsidian plugin (but a community plugin is planned)
- ❌ Not a sync engine (reads/writes your vault directory directly)
- ❌ Not a note editor (Obsidian is better at that)
- ❌ Not a cloud service (runs entirely on your machine)

It's one small thing done well: an MCP server for your vault.

---

## Roadmap

- [x] MCP server with 9 tools
- [x] Local dashboard + activity log
- [x] API key auth + permissions
- [x] Stripe licensing (free + paid tiers)
- [ ] Obsidian community plugin (one-click install)
- [ ] Agent write-back with LLM frontmatter
- [ ] Auto-tagging from vault content
- [ ] Daily digest: what changed in your vault

---

## Development

```bash
git clone https://github.com/rileygramlich/obsidian-gate.git
cd obsidian-gate
npm install
npm run build     # compile TypeScript → dist/
npm run dev       # hot-reload with tsx
```

---

Built by [Riley G.](https://github.com/rileygramlich) — inspired by the Marc Lou playbook: ship fast, free tier, zero ad spend, build in public.

**MIT** — build on it, ship it, sell it.