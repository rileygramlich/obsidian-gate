# Vault Gate

**Let AI assistants read, search, and write your Obsidian notes — without leaving your computer.**

Vault Gate runs a small [MCP](https://modelcontextprotocol.io) server inside Obsidian. Turn it on, click **Connect** next to Claude or Cursor, and your assistant can work with your vault. No terminal, no Node install, no vault path to configure.

---

## Setup

1. Install **Vault Gate** from Obsidian's community plugins and enable it.
2. The setup guide opens. Choose what assistants may do — reading and searching are on, writing is off.
3. Click **Connect** next to the assistant you use. Restart that app.

That's it. Ask it something:

| Ask | What happens |
|-----|--------------|
| "What did I write about last week?" | Reads your daily notes |
| "Search my vault for Kubernetes notes" | Full-text search across every note |
| "Summarise my meeting notes from March" | Finds them, reads them, summarises |
| "Save this to my vault as a note" | Creates a note (needs write access) |

Connecting writes the settings into the assistant's own config file and leaves a `.gate-backup` copy beside it. You can undo it any time with **Disconnect**.

### Assistants Gate can set up for you

Claude Desktop · Claude Code · Cursor · VS Code (Copilot) · Windsurf

Anything else that speaks MCP works too — hit **Copy configuration** and paste it into that client's config.

---

## What your assistant can do

Nine tools, gated by the three permissions you set in settings.

| Tool | Needs | What it does |
|------|-------|--------------|
| `list_notes` | Read | List notes and folders |
| `read_note` | Read | A note's content and frontmatter |
| `get_backlinks` | Read | Every note linking to this one |
| `get_tags` | Read | All tags, with counts |
| `get_daily_note` | Read | Today's note, created if missing |
| `search_notes` | Search | Ranked full-text search with snippets |
| `create_note` | Write | A new note, with your frontmatter template |
| `update_note` | Write | Overwrite or append |
| `create_link` | Write | Add a `[[wikilink]]` under `## Related` |

Notes are also readable as MCP resources at `obsidian://{vault}/{path}`.

---

## Privacy and safety

- **Nothing leaves your machine.** The server binds to `127.0.0.1` and there is no cloud component. Your assistant sends your notes wherever it normally sends your conversation — Gate itself uploads nothing and phones nowhere.
- **Only while Obsidian is open.** Close Obsidian and the door closes.
- **Every request needs the token** Gate generates for you. Regenerate it any time.
- **Requests from web pages are refused.** A page you have open in a browser can otherwise reach `localhost`; Gate checks the `Origin` header and turns those away.
- **Write access is off by default.** Turn it on when you want an assistant editing notes, not before.
- **The `.obsidian` config folder is off limits**, and paths that try to climb out of the vault are rejected.

---

## Settings

| Setting | Default | Notes |
|---------|---------|-------|
| Start automatically | On | Runs whenever Obsidian is open |
| Port | 22360 | Change if something else holds it |
| Name in assistant configs | `obsidian` | The key agents see the server under |
| Access token | generated | Copy or regenerate |
| Daily notes folder | vault root | Where `get_daily_note` looks |
| Search results | 50 | Cap per search |

Commands: **Start or stop the MCP server**, **Copy MCP configuration to clipboard**, **Open setup guide**.

---

## Manual configuration

For a client Gate doesn't know about:

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://127.0.0.1:22360/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Copy the filled-in version from **Settings → Vault Gate → Copy configuration**. VS Code puts this under `servers` rather than `mcpServers`.

---

## Troubleshooting

**The assistant doesn't see the vault.** Restart the assistant — most read their MCP config only at startup. Check the status bar says `Gate :22360`.

**"Port already in use."** Something else has 22360. Change the port in settings, then **Connect** again so the new URL is written out.

**Connected, but every call fails.** The token was regenerated after you connected. Click **Reconnect**.

**Nothing happens on mobile.** Gate is desktop-only — Obsidian mobile can't open a local port.

---

## Development

```bash
npm install
npm run dev     # esbuild watch → main.js
npm run build   # typecheck + production bundle
npm test        # node:test suite
```

To try it in a real vault, symlink this folder into `<vault>/.obsidian/plugins/vault-gate` and reload Obsidian.

The tests cover the parts that don't need an Electron runtime: the markdown and frontmatter helpers, the tool dispatcher and its permission checks, the MCP protocol layer, the HTTP server's auth and origin handling, and the client-config writer. `src/vault.ts` talks to the Obsidian API and is exercised by hand in a vault.

### Layout

```
manifest.json      the plugin, as the community store reads it
src/
  main.ts          plugin lifecycle, status bar, commands
  settings-tab.ts  the settings screen
  wizard.ts        first-run setup
  server.ts        the localhost HTTP endpoint
  mcp.ts           MCP over JSON-RPC
  tools.ts         the nine tools and their permissions
  vault.ts         vault access through Obsidian's API
  markdown.ts      frontmatter, links, tags, dates
server/            standalone CLI version — a separate Node MCP server
                   that reads a vault off disk. Not needed for the plugin.
```

---

## Releasing

```bash
npm version patch   # updates manifest.json and versions.json too
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which builds and attaches `main.js`, `manifest.json`, and `styles.css` to a GitHub release — the layout Obsidian's installer expects.

---

**MIT** — build on it, ship it, sell it. Built by [Riley G.](https://github.com/rileygramlich)
