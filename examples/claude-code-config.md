# Connecting Claude Code (and other MCP clients)

## Claude Code

One command:

```bash
claude mcp add obsidian -- npx obsidian-agent-connector --mcp
```

Or add it to `.mcp.json` in your project (checked in, shared with your team):

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

Pin a specific vault when you have more than one:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["obsidian-agent-connector", "--mcp", "--vault", "Work"]
    }
  }
}
```

Verify from inside Claude Code:

```
/mcp
> obsidian: connected — 9 tools
```

## Claude Desktop

`~/.config/Claude/claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["obsidian-agent-connector", "--mcp"],
      "env": { "OBSIDIAN_VAULT_PATH": "/home/you/Obsidian/Personal" }
    }
  }
}
```

## Cursor / Codex / any MCP client — HTTP transport

Start the server once (`npx obsidian-agent-connector`), then point clients at it. The HTTP
endpoint always requires an API key, so several agents can share one server with
different permissions.

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://localhost:3100/mcp",
      "headers": { "Authorization": "Bearer sk-your-key-here" }
    }
  }
}
```

Get a key with `obsidian-agent-connector keys new "Cursor"` or from the Settings page.

## MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx obsidian-agent-connector --mcp
```

The inspector lists all nine tools plus your notes as `obsidian://{vault}/{path}` resources.

## Raw JSON-RPC over HTTP

Useful for scripting or debugging auth:

```bash
curl -s http://localhost:3100/mcp \
  -H "Authorization: Bearer sk-your-key-here" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Without the header the same request returns `401`.

## Prompts that exercise each tool

| Ask your agent | Tools it uses |
|---|---|
| "What did I work on yesterday?" | `get_daily_note`, `read_note` |
| "Find every note mentioning MCP transports" | `search_notes` |
| "Start today's daily note with these three tasks" | `get_daily_note`, `update_note` |
| "Write up this design as a note under 02-Projects" | `create_note` |
| "What links to my Agent Architecture note?" | `get_backlinks` |
| "Which tags am I actually using?" | `get_tags` |
| "Link today's note to the transport notes" | `create_link` |
