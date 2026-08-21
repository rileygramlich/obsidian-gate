/**
 * Model Context Protocol implementation.
 *
 * Nine tools over one vault: list, read, search, create, update, backlinks,
 * tags, daily note, link. Works with any MCP client — Claude Code, Codex,
 * Cursor, or your own — over stdio or streamable HTTP.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getVault,
  loadConfig,
  logActivity,
  recordUsage,
  type AgentConnection,
  type Config,
} from "./config.js";
import { assertPermission } from "./auth.js";
import { enforceQueryLimit, LimitError } from "./license.js";
import { Vault, VaultError, normalizeDate } from "./vault.js";

export const SERVER_NAME = "obsidian-agent-connector";
export const SERVER_VERSION = "1.0.0";

export const TOOL_DEFINITIONS = [
  {
    name: "list_notes",
    description:
      "List notes and folders in an Obsidian vault folder. Use this to explore the vault structure before reading.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative folder path (default: vault root)",
        },
      },
    },
  },
  {
    name: "read_note",
    description:
      "Read a note's full content, including parsed YAML frontmatter and the markdown body.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative note path, e.g. '01-Daily/2026-08-21.md'",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_notes",
    description:
      "Full-text search across every note in the vault. Returns matching notes with line-level snippets, ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (all must match)" },
        limit: {
          type: "number",
          description: "Max results (default: max_search_results from config)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_note",
    description:
      "Create a new note. Frontmatter from the vault template is applied automatically. Fails if the note already exists.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path for the new note" },
        content: { type: "string", description: "Markdown content (may include its own frontmatter)" },
        frontmatter: {
          type: "object",
          description: "Extra frontmatter keys to merge in",
          additionalProperties: true,
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "update_note",
    description:
      "Overwrite an existing note's content. Last write wins — read the note first if you intend to preserve anything.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path" },
        content: { type: "string", description: "Full replacement markdown content" },
        mode: {
          type: "string",
          enum: ["overwrite", "append"],
          description: "overwrite (default) replaces the file; append adds to the end",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "get_backlinks",
    description:
      "Find every note that links to the given note via [[wikilinks]] or relative markdown links.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_tags",
    description:
      "List all tags used across the vault (frontmatter tags plus inline #tags), with usage counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_daily_note",
    description:
      "Get the daily note for a date, creating it from the vault template if it does not exist yet.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "YYYY-MM-DD, or 'today' / 'yesterday' / an offset like '-1' (default: today)",
        },
        create: {
          type: "boolean",
          description: "Create the note when missing (default: true)",
        },
      },
    },
  },
  {
    name: "create_link",
    description:
      "Add a [[wikilink]] from one note to another, appending it under a '## Related' section.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Note that will contain the link" },
        to: { type: "string", description: "Note being linked to" },
        label: { type: "string", description: "Optional display label for the link" },
      },
      required: ["from", "to"],
    },
  },
] as const;

/** Permission required by each tool. */
const TOOL_PERMISSION: Record<string, "read" | "write" | "search"> = {
  list_notes: "read",
  read_note: "read",
  search_notes: "search",
  create_note: "write",
  update_note: "write",
  get_backlinks: "read",
  get_tags: "read",
  get_daily_note: "read",
  create_link: "write",
};

export interface McpContext {
  /** The agent connection this session authenticated with, or null for stdio. */
  connection?: AgentConnection | null;
  /** Vault name override (defaults to the connection's vault, then the first vault). */
  vaultName?: string | null;
}

function resolveVault(cfg: Config, ctx: McpContext): Vault {
  const name = ctx.vaultName || ctx.connection?.vault || null;
  return new Vault(getVault(cfg, name));
}

function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/** Run one tool call. Exported so the CLI (`doctor`) can exercise it directly. */
export async function callTool(
  name: string,
  args: Record<string, any>,
  ctx: McpContext = {},
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const cfg = loadConfig(true);
  const agentName = ctx.connection?.name || "local agent";
  const permission = TOOL_PERMISSION[name];

  if (!permission) return fail(`Unknown tool: ${name}`);

  try {
    assertPermission(ctx.connection ?? null, permission);
    enforceQueryLimit(cfg);

    const vault = resolveVault(cfg, ctx);
    let summary = name;
    let result: unknown;

    switch (name) {
      case "list_notes": {
        const entries = await vault.listNotes(args.path || "");
        summary = `listed ${entries.length} entries in ${args.path || "/"}`;
        result = { vault: vault.name, path: args.path || "", count: entries.length, entries };
        break;
      }
      case "read_note": {
        const note = await vault.readNote(String(args.path));
        summary = `read note ${note.path}`;
        result = note;
        break;
      }
      case "search_notes": {
        const limit = Number(args.limit) || cfg.settings.max_search_results;
        const hits = await vault.searchNotes(String(args.query), limit);
        summary = `searched for "${args.query}" (${hits.length} hits)`;
        result = { query: args.query, count: hits.length, results: hits };
        break;
      }
      case "create_note": {
        const note = await vault.createNote(String(args.path), String(args.content ?? ""), {
          frontmatter: args.frontmatter,
        });
        summary = `created note ${note.path}`;
        recordUsage(cfg, "note_created");
        result = { created: true, ...note };
        break;
      }
      case "update_note": {
        const note =
          args.mode === "append"
            ? await vault.appendToNote(String(args.path), String(args.content ?? ""))
            : await vault.updateNote(String(args.path), String(args.content ?? ""));
        summary = `${args.mode === "append" ? "appended to" : "updated"} note ${note.path}`;
        result = { updated: true, ...note };
        break;
      }
      case "get_backlinks": {
        const links = await vault.getBacklinks(String(args.path));
        summary = `found ${links.length} backlinks to ${args.path}`;
        result = { path: args.path, count: links.length, backlinks: links };
        break;
      }
      case "get_tags": {
        const tags = await vault.getTags();
        summary = `listed ${tags.length} tags`;
        result = { count: tags.length, tags };
        break;
      }
      case "get_daily_note": {
        const date = normalizeDate(args.date);
        const { note, created } = await vault.getDailyNote(
          args.date,
          args.create !== false,
        );
        summary = `${created ? "created" : "read"} daily note ${date}`;
        if (created) recordUsage(cfg, "note_created");
        result = { date, created, ...note };
        break;
      }
      case "create_link": {
        const link = await vault.createLink(
          String(args.from),
          String(args.to),
          args.label ? String(args.label) : undefined,
        );
        summary = link.alreadyLinked
          ? `${link.from} already links to ${link.to}`
          : `linked ${link.from} → ${link.to}`;
        result = link;
        break;
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }

    recordUsage(loadConfig(true), "query");
    logActivity({ agent: agentName, tool: name, summary, vault: vault.name, ok: true });
    return ok(result);
  } catch (err) {
    const message =
      err instanceof VaultError || err instanceof LimitError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    logActivity({ agent: agentName, tool: name, summary: message, ok: false });
    return fail(message);
  }
}

/** Build a configured MCP server instance. One per client session. */
export function createMcpServer(ctx: McpContext = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as any,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return callTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, any>,
      ctx,
    );
  });

  // Resources: notes are exposed as obsidian://{vault}/{path}
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const cfg = loadConfig(true);
    try {
      const vault = resolveVault(cfg, ctx);
      const notes = await vault.allNotes();
      return {
        resources: notes.slice(0, 500).map((rel) => ({
          uri: `obsidian://${encodeURIComponent(vault.name)}/${rel
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          name: rel.replace(/\.(md|markdown)$/i, ""),
          description: `Obsidian note in vault "${vault.name}"`,
          mimeType: "text/markdown",
        })),
      };
    } catch {
      return { resources: [] };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const cfg = loadConfig(true);
    const uri = request.params.uri;
    const match = /^obsidian:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (!match) throw new Error(`Unsupported resource URI: ${uri}`);
    const vaultName = decodeURIComponent(match[1]);
    const rel = match[2].split("/").map(decodeURIComponent).join("/");
    const vault = new Vault(getVault(cfg, vaultName));
    const note = await vault.readNote(rel);
    logActivity({
      agent: ctx.connection?.name || "local agent",
      tool: "read_resource",
      summary: `read resource ${note.path}`,
      vault: vault.name,
      ok: true,
    });
    return {
      contents: [{ uri, mimeType: "text/markdown", text: note.content }],
    };
  });

  return server;
}
