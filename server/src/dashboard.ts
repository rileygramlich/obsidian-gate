/**
 * Local web dashboard + MCP-over-HTTP endpoint.
 *
 * Serves the static pages in public/ and a small JSON API the dashboard reads.
 * Nothing here talks to a backend: every byte comes from the local config file
 * and the vault on disk.
 */
import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar, { type FSWatcher } from "chokidar";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  addVault,
  loadConfig,
  log,
  logActivity,
  readActivity,
  removeVault,
  saveConfig,
  expandHome,
  type Config,
  type Permission,
} from "./config.js";
import {
  ALL_PERMISSIONS,
  createConnection,
  findConnection,
  maskKey,
  requireAuth,
  revokeConnection,
  rotateConnection,
  setPermissions,
  extractKey,
  type AuthedRequest,
} from "./auth.js";
import {
  claimLicenseFromSession,
  createCheckoutSession,
  createPortalSession,
  enforceConnectionLimit,
  enforceVaultLimit,
  licenseSummary,
  validateLicense,
} from "./license.js";
import { createMcpServer, SERVER_VERSION } from "./mcp-server.js";
import { Vault } from "./vault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

interface VaultIndexState {
  notes: number;
  folders: number;
  bytes: number;
  last_indexed: string | null;
  error: string | null;
}

const indexState = new Map<string, VaultIndexState>();
let watcher: FSWatcher | null = null;

async function refreshIndex(cfg: Config): Promise<void> {
  for (const v of cfg.vaults) {
    try {
      const stats = await new Vault(v).stats();
      indexState.set(v.name, { ...stats, last_indexed: new Date().toISOString(), error: null });
    } catch (err) {
      indexState.set(v.name, {
        notes: 0,
        folders: 0,
        bytes: 0,
        last_indexed: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function watchVaults(cfg: Config): void {
  watcher?.close();
  const paths = cfg.vaults.map((v) => v.path).filter(Boolean);
  if (!paths.length) return;
  watcher = chokidar.watch(paths, {
    ignored: (p: string) => /(^|[/\\])\.(obsidian|git|trash)([/\\]|$)/.test(p),
    ignoreInitial: true,
    depth: 8,
  });
  let pending: NodeJS.Timeout | null = null;
  const debounced = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => refreshIndex(loadConfig(true)), 1500);
  };
  watcher.on("add", debounced).on("unlink", debounced).on("change", debounced);
}

/** True when the request came from this machine (::1 / 127.0.0.0/8). */
function isLoopback(req: Request): boolean {
  const ip = (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "::1" || ip.startsWith("127.");
}

function wrap(handler: (req: AuthedRequest, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req as AuthedRequest, res);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export function createDashboardApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.disable("x-powered-by");

  const auth = requireAuth({ allowLoopback: true });

  /* ------------------------- MCP over HTTP ------------------------- */
  // Always key-protected: this endpoint hands out vault access.
  app.all("/mcp", async (req: Request, res: Response) => {
    const cfg = loadConfig(true);
    const key = extractKey(req);
    const connection = findConnection(cfg, key);
    if (!connection) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: valid API key required (Authorization: Bearer <key>)." },
        id: null,
      });
      return;
    }
    connection.last_used = new Date().toISOString();
    saveConfig(cfg);

    // Stateless: a fresh server + transport per request keeps concurrent
    // agents from stepping on each other.
    const server = createMcpServer({ connection, vaultName: connection.vault });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(cfg, "error", "MCP request failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed." });
    }
  });

  /* ----------------------------- API ------------------------------- */

  app.get("/api/status", auth, wrap(async (req, res) => {
    const cfg = loadConfig(true);
    if (!indexState.size) await refreshIndex(cfg);
    res.json({
      server: { version: SERVER_VERSION, port: cfg.settings.port, uptime_s: Math.round(process.uptime()) },
      vaults: cfg.vaults.map((v) => ({
        name: v.name,
        path: v.path,
        daily_notes_path: v.daily_notes_path,
        ...(indexState.get(v.name) ?? { notes: 0, folders: 0, bytes: 0, last_indexed: null, error: null }),
      })),
      connections: cfg.agent_connections.length,
      active: cfg.agent_connections.some(
        (c) => c.last_used && Date.now() - Date.parse(c.last_used) < 10 * 60 * 1000,
      ),
      license: licenseSummary(cfg),
      settings: cfg.settings,
    });
  }));

  app.post("/api/reindex", auth, wrap(async (_req, res) => {
    const cfg = loadConfig(true);
    await refreshIndex(cfg);
    res.json({ ok: true, vaults: Object.fromEntries(indexState) });
  }));

  app.get("/api/activity", auth, wrap((req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    res.json({ activity: readActivity(limit) });
  }));

  app.get("/api/usage", auth, wrap((_req, res) => {
    const cfg = loadConfig(true);
    res.json({ usage: cfg.usage, license: licenseSummary(cfg) });
  }));

  app.get("/api/agents", auth, wrap((_req, res) => {
    const cfg = loadConfig(true);
    res.json({
      agents: cfg.agent_connections.map((c) => ({
        name: c.name,
        vault: c.vault,
        permissions: c.permissions,
        created: c.created ?? null,
        last_used: c.last_used,
        key_masked: maskKey(c.key),
        key_id: c.key.slice(-8),
      })),
      all_permissions: ALL_PERMISSIONS,
    });
  }));

  app.post("/api/agents", auth, wrap((req, res) => {
    const cfg = loadConfig(true);
    enforceConnectionLimit(cfg);
    const name = String(req.body?.name || "New agent");
    const vault = String(req.body?.vault || cfg.vaults[0]?.name || "");
    const permissions = (Array.isArray(req.body?.permissions)
      ? req.body.permissions
      : ALL_PERMISSIONS) as Permission[];
    const conn = createConnection(cfg, name, vault, permissions);
    logActivity({ agent: name, tool: "create_connection", summary: `created API key for ${name}`, ok: true });
    // The full key is shown exactly once, at creation.
    res.json({ agent: { ...conn }, key: conn.key });
  }));

  const byKeyId = (cfg: Config, id: string) =>
    cfg.agent_connections.find((c) => c.key.endsWith(id));

  app.post("/api/agents/:id/rotate", auth, wrap((req, res) => {
    const cfg = loadConfig(true);
    const conn = byKeyId(cfg, String(req.params.id));
    if (!conn) { res.status(404).json({ error: "No such agent connection." }); return; }
    const rotated = rotateConnection(cfg, conn.key)!;
    logActivity({ agent: rotated.name, tool: "rotate_key", summary: `rotated API key`, ok: true });
    res.json({ agent: rotated, key: rotated.key });
  }));

  app.post("/api/agents/:id/permissions", auth, wrap((req, res) => {
    const cfg = loadConfig(true);
    const conn = byKeyId(cfg, String(req.params.id));
    if (!conn) { res.status(404).json({ error: "No such agent connection." }); return; }
    const updated = setPermissions(cfg, conn.key, (req.body?.permissions ?? []) as Permission[]);
    res.json({ agent: { ...updated, key: undefined, key_masked: maskKey(conn.key) } });
  }));

  app.delete("/api/agents/:id", auth, wrap((req, res) => {
    const cfg = loadConfig(true);
    const conn = byKeyId(cfg, String(req.params.id));
    if (!conn) { res.status(404).json({ error: "No such agent connection." }); return; }
    revokeConnection(cfg, conn.key);
    logActivity({ agent: conn.name, tool: "revoke_key", summary: `revoked API key`, ok: true });
    res.json({ ok: true });
  }));

  app.get("/api/vaults", auth, wrap((_req, res) => {
    res.json({ vaults: loadConfig(true).vaults });
  }));

  app.post("/api/vaults", auth, wrap((req, res) => {
    const cfg = loadConfig(true);
    const name = String(req.body?.name || "").trim();
    const vaultPath = expandHome(String(req.body?.path || "").trim());
    if (!name || !vaultPath) throw new Error("Both name and path are required.");
    if (!cfg.vaults.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
      enforceVaultLimit(cfg);
    }
    const vault = new Vault({
      name,
      path: vaultPath,
      daily_notes_path: String(req.body?.daily_notes_path || "01-Daily/"),
      frontmatter_template: req.body?.frontmatter_template ?? { created: "{{date}}", tags: [] },
    });
    vault.assertExists();
    addVault(cfg, {
      name,
      path: vault.root,
      daily_notes_path: vault.dailyNotesPath,
      frontmatter_template: vault.frontmatterTemplate,
    });
    refreshIndex(loadConfig(true));
    watchVaults(loadConfig(true));
    res.json({ ok: true, vaults: loadConfig(true).vaults });
  }));

  app.delete("/api/vaults/:name", auth, wrap((req, res) => {
    const cfg = loadConfig(true);
    removeVault(cfg, String(req.params.name));
    indexState.delete(String(req.params.name));
    res.json({ ok: true, vaults: loadConfig(true).vaults });
  }));

  app.post("/api/settings", auth, wrap((req, res) => {
    const cfg = loadConfig(true);
    if (req.body?.port) cfg.settings.port = Number(req.body.port);
    if (req.body?.log_level) cfg.settings.log_level = req.body.log_level;
    if (req.body?.max_search_results) {
      cfg.settings.max_search_results = Number(req.body.max_search_results);
    }
    saveConfig(cfg);
    res.json({ ok: true, settings: cfg.settings });
  }));

  /* --------------------------- Billing ----------------------------- */

  app.get("/api/license", auth, wrap((_req, res) => {
    res.json(licenseSummary(loadConfig(true)));
  }));

  app.post("/api/license", auth, wrap(async (req, res) => {
    const cfg = loadConfig(true);
    cfg.license.key = String(req.body?.key || "").trim() || null;
    cfg.license.checked_at = null;
    saveConfig(cfg);
    await validateLicense(cfg, { force: true });
    res.json(licenseSummary(loadConfig(true)));
  }));

  app.post("/api/checkout", wrap(async (req, res) => {
    const plan = req.body?.plan === "team" ? "team" : "personal";
    const publicUrl =
      process.env.PUBLIC_URL || `${req.protocol}://${req.get("host") ?? "localhost"}`;
    const session = await createCheckoutSession(plan, publicUrl);
    res.json(session);
  }));

  // Stripe redirects the buyer here with ?session_id=... — this is where the
  // license key they just paid for actually gets minted. Left unauthenticated
  // on purpose: the buyer may be returning to a vendor-hosted page rather than
  // their own dashboard, and the unguessable session ID is the credential.
  app.post("/api/checkout/claim", wrap(async (req, res) => {
    const sessionId = String(req.body?.session_id || "").trim();
    if (!sessionId) throw new Error("A checkout session ID is required.");
    const claimed = await claimLicenseFromSession(sessionId);

    // Only a local browser gets the key written straight into the config; a
    // remote buyer copies it into their own machine's dashboard.
    let activated = false;
    if (isLoopback(req)) {
      const cfg = loadConfig(true);
      cfg.license.key = claimed.key;
      cfg.license.checked_at = null;
      saveConfig(cfg);
      await validateLicense(cfg, { force: true });
      activated = true;
      logActivity({
        agent: "dashboard",
        tool: "claim_license",
        summary: `activated ${claimed.tier} license from checkout`,
        ok: true,
      });
    }
    res.json({ ...claimed, activated });
  }));

  app.post("/api/portal", auth, wrap(async (req, res) => {
    const publicUrl =
      process.env.PUBLIC_URL || `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json(await createPortalSession(loadConfig(true), publicUrl));
  }));

  app.get("/api/mcp-config", auth, wrap((req, res) => {
    const cfg = loadConfig(true);
    const key = cfg.agent_connections[0]?.key ?? "sk-run-obsidian-gate-init-first";
    res.json({
      stdio: {
        mcpServers: {
          obsidian: { command: "npx", args: ["obsidian-gate", "--mcp"] },
        },
      },
      http: {
        mcpServers: {
          obsidian: {
            type: "http",
            url: `http://localhost:${cfg.settings.port}/mcp`,
            headers: { Authorization: `Bearer ${key}` },
          },
        },
      },
    });
  }));

  /* --------------------------- Pages ------------------------------- */
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
  app.get("/dashboard", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "dashboard.html")));
  app.get("/install", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "install.html")));
  app.get("/settings", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "settings.html")));
  app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, "index.html")));

  return app;
}

export async function startDashboard(
  port?: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  const cfg = loadConfig(true);
  const listenPort = port ?? cfg.settings.port;
  await validateLicense(cfg).catch(() => undefined);
  await refreshIndex(cfg);
  watchVaults(cfg);

  const app = createDashboardApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, () => {
      resolve({
        port: listenPort,
        close: () =>
          new Promise<void>((done) => {
            watcher?.close();
            server.close(() => done());
          }),
      });
    });
    server.on("error", reject);
  });
}

export { refreshIndex, randomUUID };
