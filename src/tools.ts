/**
 * The nine tools Gate exposes over MCP, and the dispatcher that runs them.
 *
 * Tool definitions are plain data so they can be listed in the settings UI and
 * asserted against in tests without booting a server.
 */
import { GateError, normalizeDate } from "./markdown";
import type { GateVault } from "./vault";

export type Permission = "read" | "write" | "search";

export interface ToolDefinition {
  name: string;
  description: string;
  permission: Permission;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_notes",
    permission: "read",
    description:
      "List notes and folders in a vault folder. Use this to explore the vault structure before reading.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative folder path (default: vault root)" },
      },
    },
  },
  {
    name: "read_note",
    permission: "read",
    description:
      "Read a note's full content, including parsed YAML frontmatter and the markdown body.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path, e.g. '01-Daily/2026-08-21.md'" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_notes",
    permission: "search",
    description:
      "Full-text search across every note in the vault. Returns matching notes with line-level snippets, ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (all must match)" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_note",
    permission: "write",
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
    permission: "write",
    description:
      "Overwrite or append to an existing note. Overwrite is last-write-wins — read the note first if you intend to preserve anything.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative note path" },
        content: { type: "string", description: "Replacement or appended markdown" },
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
    permission: "read",
    description:
      "Find every note that links to the given note, resolved through Obsidian's own link index.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative note path" } },
      required: ["path"],
    },
  },
  {
    name: "get_tags",
    permission: "read",
    description:
      "List all tags used across the vault (frontmatter tags plus inline #tags), with usage counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_daily_note",
    permission: "read",
    description:
      "Get the daily note for a date, creating it from the vault template if it does not exist yet.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "YYYY-MM-DD, or 'today' / 'yesterday' / an offset like '-1' (default: today)",
        },
        create: { type: "boolean", description: "Create the note when missing (default: true)" },
      },
    },
  },
  {
    name: "create_link",
    permission: "write",
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
];

export const TOOLS_BY_NAME = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolContext {
  vault: GateVault;
  /** Permissions the calling client was granted. */
  permissions: Permission[];
  /** Called after every attempt so the plugin can render an activity log. */
  onActivity?: (entry: { tool: string; summary: string; ok: boolean }) => void;
}

const ok = (payload: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});

const fail = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/** Filter the advertised tool list down to what this client may actually call. */
export function toolsFor(permissions: Permission[]): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => permissions.includes(t.permission));
}

export async function callTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const def = TOOLS_BY_NAME.get(name);
  if (!def) return fail(`Unknown tool: ${name}`);

  try {
    if (!ctx.permissions.includes(def.permission)) {
      throw new GateError(
        `This connection lacks "${def.permission}" permission. Grant it in Obsidian under Settings → Vault Gate.`,
      );
    }

    const { vault } = ctx;
    let summary = name;
    let result: unknown;

    switch (name) {
      case "list_notes": {
        const path = args.path ? String(args.path) : "";
        const entries = await vault.listNotes(path);
        summary = `listed ${entries.length} entries in ${path || "/"}`;
        result = { vault: vault.name, path, count: entries.length, entries };
        break;
      }
      case "read_note": {
        const note = await vault.readNote(String(args.path));
        summary = `read note ${note.path}`;
        result = note;
        break;
      }
      case "search_notes": {
        const limit = Number(args.limit) || undefined;
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
        result = { created: true, ...note };
        break;
      }
      case "update_note": {
        const append = args.mode === "append";
        const note = append
          ? await vault.appendToNote(String(args.path), String(args.content ?? ""))
          : await vault.updateNote(String(args.path), String(args.content ?? ""));
        summary = `${append ? "appended to" : "updated"} note ${note.path}`;
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
        const { note, created } = await vault.getDailyNote(date, args.create !== false);
        summary = `${created ? "created" : "read"} daily note ${date}`;
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

    ctx.onActivity?.({ tool: name, summary, ok: true });
    return ok(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.onActivity?.({ tool: name, summary: message, ok: false });
    return fail(message);
  }
}
