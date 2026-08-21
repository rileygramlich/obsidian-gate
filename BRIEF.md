# Obsidian Agent Connector — Build Brief

## The One-Sentence Pitch
An MCP server that lets any AI agent (Claude Code, Codex, Cursor, custom agents) read, search, write, and connect notes in your Obsidian vault — turning your knowledge base into an agent-accessible workspace.

## Core Feature (ONE FEATURE ONLY)
An MCP server that exposes the following tools to any AI agent:

```
- list_notes(path?)          → List notes in a vault folder
- read_note(path)            → Get full note content (markdown + frontmatter)
- search_notes(query)        → Full-text search across vault
- create_note(path, content) → Create a new note with frontmatter
- update_note(path, content)  → Overwrite a note's content
- get_backlinks(path)        → Find all notes linking to this one
- get_tags()                 → List all tags across the vault
- get_daily_note(date?)      → Get or create a daily note for a date
- create_link(from, to, label?) → Add a [[wikilink]] between two notes
```

**That's it.** The MCP server + a one-page web dashboard to see agent activity. No sync engine. No cloud sync. No mobile app. No multi-vault orchestration.

## Tech Stack
- **Core:** Node.js (TypeScript), MCP SDK (`@modelcontextprotocol/sdk`)
- **Storage:** Direct filesystem access to the Obsidian vault
- **Config:** Simple `.env` file or `~/.obsidian-agent/config.json`
- **Frontend:** Single HTML page (dashboard showing agent activity)
- **Payments:** Stripe Checkout ($19/mo personal, $49/mo team)
- **Deploy:** npm package + `npx obsidian-agent` (no server needed — runs locally)

## Marc Lou Philosophy (Build Ethos)

This product follows **Marc Lou's zero-ad-spend distribution playbook**:

- **No paid ads. Ever.** Distribution is entirely organic: GitHub → npm → HN Show HN → Obsidian community (Reddit, Discord, forum). Building in public on Twitter/X is the marketing engine.
- **Ship fast, validate later.** Launch the MCP server raw. Add Stripe licensing *after* people are using it and asking to pay. A 14-day trial with card gets you signal, but free unlimited use for early adopters gets you distribution.
- **Free tier hooks them first.** Let devs `npx obsidian-agent` and have it work immediately with no paywall. 50 queries free/month. Only introduce paid tiers when the pain of "I hit the free limit" exceeds the friction of entering a credit card.
- **One feature, done well.** The MCP server is the product. The dashboard is a nice-to-have. Do NOT build features no one has asked for yet.
- **Price anchors high, validate demand.** $19/mo personal / $49/mo team. If nobody pays, drop to $9 or make it donation-supported. Revenue is validation, not the goal at MVP.

## Monetization Strategy

| Model | What |
|-------|------|
| **Free tier (acquisition)** | `npx obsidian-agent` works immediately. 50 queries/month, 1 vault, 1 agent connection. No credit card needed. |
| **Pro tier (revenue)** | $19/mo. Unlimited queries, unlimited agents, up to 3 vaults. 14-day free trial requires card. |
| **Team tier (scale)** | $49/mo. Up to 5 vaults, shared config, team management. |

**When to charge:** Not on day 1. Ship the MCP server free-first. The moment someone says "I want more queries" = that's your pricing signal.

**Why this works:**
- The MCP ecosystem is exploding in 2026 — developers WANT to plug their vaults into agents
- Obsidian has 2M+ power users, mostly developers
- No existing MCP server for Obsidian has gone mainstream yet
- `npx obsidian-agent` is a 3-second install — zero friction
- Word of mouth is the only distribution channel that matters at this stage

## Data Model (Local Config File)

```json
{
  "version": 1,
  "vaults": [
    {
      "name": "Personal",
      "path": "/home/user/Obsidian/MyVault",
      "daily_notes_path": "01-Daily/",
      "frontmatter_template": {
        "created": "{{date}}",
        "tags": []
      }
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
  "settings": {
    "port": 3100,
    "log_level": "info",
    "max_search_results": 50
  }
}
```

## Pages

### 1. Landing Page (`/`)
- Hero: "Let your AI agents read and write your Obsidian vault"
- Features:
  - 🔍 Search any note from any agent
  - ✍️ AI writes notes directly to your vault
  - 🔗 Auto-creates links between related notes
  - 📅 Daily note integration
- Screenshot: Claude Code asking "What did I work on yesterday?" → agent reads the vault
- Pricing: $19/mo personal, $49/mo team
- CTA: "Install Now" → `npx obsidian-agent` (credit card required for full access)
- Footer: GitHub | Docs | Changelog

### 2. Install Page (`/install`)
- Inline terminal: `npx obsidian-agent init`
- Interactive config wizard:
  - Path to vault → `~/.obsidian-agent/config.json`
  - Generate API key
  - Test connection
- "Or use the Obsidian plugin" → download from community plugins

### 3. Dashboard (`/dashboard`)
- **Status card:** Vault path, total notes, last indexed, connection active/inactive
- **Recent agent activity:** Timestamp, agent name, what they did ("read daily note", "created note", "searched for 'MCP'")
- **Connected agents:** Table of API keys with last used, permissions
- **Usage stats:** Queries this month, notes created by AI, tokens consumed

### 4. Settings (`/settings`)
- Regenerate API key
- Add/remove vaults
- Manage permissions per agent connection
- Cancel subscription (Stripe Customer Portal)

## MCP Server Protocol

The server implements the **Model Context Protocol** so it works with ANY MCP-compatible agent:

```typescript
// MCP Tool Definitions
{
  name: "list_notes",
  description: "List notes in a vault folder",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path (default: root)" }
    }
  }
}

// MCP Resource Definitions
{
  uri: "obsidian://{vault}/{path}",
  name: "Obsidian Note",
  mimeType: "text/markdown"
}
```

**How agents connect:**

```bash
# Claude Code
claude --mcp "obsidian-agent" --mcp-port 3100

# Generic MCP client
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["obsidian-agent", "--mcp"]
    }
  }
}
```

## What NOT to Build (MVP)

- ❌ No cloud sync (filesystem direct access only)
- ❌ No Obsidian plugin (ship as MCP server first, plugin later)
- ❌ No mobile app
- ❌ No multi-vault search across machines
- ❌ No graph visualization
- ❌ No AI-powered auto-tagging or auto-linking
- ❌ No conflict resolution (last write wins)
- ❌ No web UI for editing notes
- ❌ No version history

## What NOT to Do

- Do not build a SaaS backend. The MCP server runs locally on the user's machine.
- Do not store user data in the cloud. Everything is local.
- Do not add a plugin marketplace or extension system.
- Do not build a custom sync protocol. Obsidian sync handles this.
- Do not require a database. Config is JSON files.

## Design Style

- Clean, minimal, Obsidian-vibe (warm grays, deep purple accent #7C3AED)
- Monospace code blocks throughout (developer audience)
- Dark/light mode toggle (like Obsidian itself)
- Font: Inter + JetBrains Mono for code
- Terminal-style install instructions (green-on-black code blocks)

## Verification

1. `npx obsidian-agent` starts on port 3100
2. MCP inspector connects and sees all tools
3. Agent can list notes, read a note, search, create a note
4. Created note appears in the actual Obsidian vault filesystem
5. Dashboard shows agent activity
6. API key auth works (rejects unauthenticated requests)
7. Landing page loads and looks professional
8. Stripe checkout flow works end-to-end

## Stripe Products (create in dashboard)

**Product:** Obsidian Agent Connector  
**Price:** $19/month (personal), $49/month (team)  
**Trial:** 14 days

## Build Order (for Claude Code)

1. `npm init` + install deps: `@modelcontextprotocol/sdk`, `commander`, `express`, `stripe`, `chokidar`
2. Create `src/mcp-server.ts` — MCP tool handlers for all 9 operations
3. Create `src/vault.ts` — filesystem operations (read, write, search, link parsing)
4. Create `src/config.ts` — config file loading, validation, migration
5. Create `src/auth.ts` — API key generation and validation
6. Create `src/dashboard.ts` — Express server for the web dashboard
7. Create `public/index.html` — Landing page
8. Create `public/dashboard.html` — Activity dashboard
9. Create `public/install.html` — Install/setup page
10. Create `public/settings.html` — Settings page
11. Create `public/styles.css` — All styles
12. Create `src/cli.ts` — CLI entry point (`npx obsidian-agent`)
13. Add Stripe license key validation (check subscription on startup)
14. Add `README.md` with install instructions and MCP config examples
15. Test: MCP inspector connects, all tools work, dashboard renders

## Files to Create

```
obsidian-agent/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts           # CLI entry point
│   ├── mcp-server.ts      # MCP protocol implementation
│   ├── vault.ts           # Filesystem operations
│   ├── config.ts          # Config management
│   ├── auth.ts            # API key management
│   ├── license.ts         # Stripe license validation
│   └── dashboard.ts       # Express dashboard server
├── public/
│   ├── index.html         # Landing page
│   ├── install.html       # Install/setup page
│   ├── dashboard.html     # Activity dashboard
│   ├── settings.html      # Settings page
│   └── styles.css         # All styles
└── examples/
    └── claude-code-config.md  # Claude Code MCP config example
```

## Build Priority (Marc Lou Order)

**Phase 1 — Ship the MCP server (today)**
1. MCP tools work on local vault
2. `npx obsidian-agent` installs and runs
3. No Stripe, no licensing, no auth — just raw tools
4. Test with Claude Code and MCP inspector
5. Ship to npm as v0.1.0

**Phase 2 — Free tier with optional key (when someone asks)**
1. Add API key generation (local, no Stripe)
2. Query counting (50/month free, stored locally)
3. When they hit the limit → "Upgrade for unlimited"

**Phase 3 — Stripe billing (when someone pays)**
1. Only add Stripe when a real person asks "how do I pay for more?"
2. License key validated on startup
3. 14-day free trial with card

**Phase 4 — Distribution (always)**
1. GitHub repo with clean README
2. `npx obsidian-agent` discoverability
3. HN Show HN when it works
4. Obsidian Reddit/Discord when it's polished
5. Twitter/X build threads showing progress

## Post-MVP Ideas (v2, if you get 10+ paying customers)

- Obsidian community plugin (one-click install from Obsidian)
- Agent write-back with frontmatter generation
- Auto-tagging based on content
- "What changed today" — agent digest of vault activity
- Shared vaults for team knowledge bases
- Graph view of agent-created connections