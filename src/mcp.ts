/**
 * Model Context Protocol, implemented directly over JSON-RPC.
 *
 * The official SDK's HTTP transport assumes a Node server process and pulls in
 * a lot of machinery a plugin doesn't need. A stateless MCP server is small
 * enough to write out: dispatch a handful of methods, answer POSTs with plain
 * JSON. Keeping it dependency-free also keeps main.js small and auditable,
 * which matters for community-plugin review.
 */
import { TOOL_DEFINITIONS, callTool, toolsFor, type ToolContext } from "./tools";

export const SERVER_NAME = "vault-gate";
export const SERVER_VERSION = "1.0.0";

/** Protocol revisions this server understands, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function error(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handle one JSON-RPC message.
 *
 * Returns null for notifications (no `id`), which get an HTTP 202 and no body.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  ctx: ToolContext,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined || message.id === null;

  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return isNotification ? null : error(id, INVALID_REQUEST, "Malformed JSON-RPC request.");
  }

  try {
    switch (message.method) {
      case "initialize": {
        const asked = String(message.params?.protocolVersion ?? "");
        const version = SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : LATEST_PROTOCOL_VERSION;
        return result(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Read, search, and write notes in the user's Obsidian vault. " +
            "Explore with list_notes or search_notes before reading a specific note.",
        });
      }

      // Client lifecycle notifications: nothing to do, but they must not 404.
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "ping":
        return result(id, {});

      case "tools/list":
        return result(id, {
          tools: toolsFor(ctx.permissions).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const args = (message.params?.arguments ?? {}) as Record<string, any>;
        return result(id, await callTool(name, args, ctx));
      }

      case "resources/list": {
        if (!ctx.permissions.includes("read")) return result(id, { resources: [] });
        const notes = await ctx.vault.allNotes();
        const vaultName = ctx.vault.name;
        return result(id, {
          // Capped: a large vault would otherwise blow past any client's
          // context budget on a single list call.
          resources: notes.slice(0, 500).map((rel) => ({
            uri: noteUri(vaultName, rel),
            name: rel.replace(/\.(md|markdown)$/i, ""),
            description: `Note in vault "${vaultName}"`,
            mimeType: "text/markdown",
          })),
        });
      }

      case "resources/read": {
        const uri = String(message.params?.uri ?? "");
        const rel = parseNoteUri(uri);
        if (!rel) throw new Error(`Unsupported resource URI: ${uri}`);
        const note = await ctx.vault.readNote(rel);
        ctx.onActivity?.({
          tool: "read_resource",
          summary: `read resource ${note.path}`,
          ok: true,
        });
        return result(id, {
          contents: [{ uri, mimeType: "text/markdown", text: note.content }],
        });
      }

      case "prompts/list":
        return result(id, { prompts: [] });

      case "resources/templates/list":
        return result(id, { resourceTemplates: [] });

      default:
        return isNotification
          ? null
          : error(id, METHOD_NOT_FOUND, `Unknown method: ${message.method}`);
    }
  } catch (err) {
    const message_ = err instanceof Error ? err.message : String(err);
    return isNotification ? null : error(id, INTERNAL_ERROR, message_);
  }
}

/** Handle a parsed POST body: either one message or a batch of them. */
export async function handlePayload(
  payload: unknown,
  ctx: ToolContext,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    const responses: JsonRpcResponse[] = [];
    for (const item of payload) {
      const res = await handleMessage(item as JsonRpcRequest, ctx);
      if (res) responses.push(res);
    }
    return responses.length ? responses : null;
  }
  if (!payload || typeof payload !== "object") {
    return error(null, PARSE_ERROR, "Request body must be a JSON-RPC message.");
  }
  return handleMessage(payload as JsonRpcRequest, ctx);
}

export function noteUri(vaultName: string, rel: string): string {
  const path = rel.split("/").map(encodeURIComponent).join("/");
  return `obsidian://${encodeURIComponent(vaultName)}/${path}`;
}

export function parseNoteUri(uri: string): string | null {
  const match = /^obsidian:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) return null;
  return match[2].split("/").map(decodeURIComponent).join("/");
}

export { TOOL_DEFINITIONS };
