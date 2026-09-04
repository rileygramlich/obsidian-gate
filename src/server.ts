/**
 * The local HTTP endpoint agents connect to.
 *
 * Bound to 127.0.0.1 only, and every request must carry the plugin's token.
 * The Origin check is not optional politeness: without it any web page the
 * user has open could POST to localhost and read their vault (DNS rebinding),
 * which the MCP transport spec calls out specifically.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handlePayload } from "./mcp";
import { SERVER_NAME, SERVER_VERSION } from "./mcp";
import type { ToolContext } from "./tools";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface GateServerOptions {
  port: number;
  /** Bearer token every request must present. */
  token: string;
  /** Built fresh per request so settings changes take effect immediately. */
  context: () => ToolContext;
  onError?: (err: Error) => void;
}

export type ServerStatus =
  | { state: "stopped" }
  | { state: "running"; port: number }
  | { state: "error"; message: string };

export class GateServer {
  private server: Server | null = null;
  private status: ServerStatus = { state: "stopped" };

  constructor(private options: GateServerOptions) {}

  getStatus(): ServerStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.status.state === "running";
  }

  update(options: Partial<GateServerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  async start(): Promise<ServerStatus> {
    await this.stop();
    const { port } = this.options;

    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
          if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
        });
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        const message =
          err.code === "EADDRINUSE"
            ? `Port ${port} is already in use. Pick another port in Settings → Vault Gate.`
            : err.message;
        this.status = { state: "error", message };
        this.server = null;
        this.options.onError?.(new Error(message));
        resolve(this.status);
      });

      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        this.status = { state: "running", port };
        resolve(this.status);
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.status = { state: "stopped" };
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // closeAllConnections keeps a keep-alive client from holding the port,
      // which would break the very next start() on a settings change.
      server.closeAllConnections?.();
    });
  }

  /* ---------------------------- request path --------------------------- */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.options.port}`);

    if (!this.originAllowed(req)) {
      sendJson(res, 403, { error: "Forbidden origin." });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders()).end();
      return;
    }

    // Unauthenticated so a user can sanity-check the endpoint in a browser.
    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, server: SERVER_NAME, version: SERVER_VERSION });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }

    if (!this.authorized(req, url)) {
      sendJson(res, 401, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message:
            "Unauthorized. Send the Vault Gate token as `Authorization: Bearer <token>`.",
        },
      });
      return;
    }

    // GET opens the server→client SSE stream. This server never initiates
    // messages, so declining is correct and clients handle it.
    if (req.method === "GET") {
      sendJson(res, 405, { error: "This server does not offer an SSE stream." });
      return;
    }

    // DELETE ends a session. Stateless server: nothing to tear down.
    if (req.method === "DELETE") {
      res.writeHead(204, corsHeaders()).end();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: `Method ${req.method} not allowed.` });
      return;
    }

    let payload: unknown;
    try {
      const body = await readBody(req);
      payload = body ? JSON.parse(body) : null;
    } catch (err) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : "Parse error." },
      });
      return;
    }

    const response = await handlePayload(payload, this.options.context());
    if (response === null) {
      // Notifications only — nothing to say back.
      res.writeHead(202, corsHeaders()).end();
      return;
    }
    sendJson(res, 200, response);
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    const bearer =
      header && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
    const apiKey = firstHeader(req.headers["x-api-key"]);
    const query = url.searchParams.get("key");
    const supplied = bearer || apiKey || query;
    return !!supplied && timingSafeEqual(supplied, this.options.token);
  }

  /**
   * Allow requests with no Origin (every MCP client) and localhost origins
   * (the settings-page test button). Reject anything else — that's a browser
   * on some other site trying its luck.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = firstHeader(req.headers.origin);
    if (!origin) return true;
    try {
      const { hostname, protocol } = new URL(origin);
      if (protocol === "app:" || protocol === "obsidian:") return true;
      return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    } catch {
      return false;
    }
  }
}

/* ------------------------------- helpers -------------------------------- */

function firstHeader(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, mcp-session-id, mcp-protocol-version",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Compare without leaking the token's length or prefix through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
