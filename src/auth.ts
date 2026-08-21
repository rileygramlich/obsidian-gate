/**
 * API key generation and validation.
 *
 * Keys are local secrets stored in ~/.obsidian-agent/config.json (mode 0600).
 * They gate access to the MCP-over-HTTP endpoint and the dashboard API, so a
 * stray process on the machine — or anything on the LAN — can't read your vault.
 */
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import {
  loadConfig,
  saveConfig,
  type AgentConnection,
  type Config,
  type Permission,
} from "./config.js";

export const ALL_PERMISSIONS: Permission[] = ["read", "write", "search"];

export function generateKey(): string {
  return `sk-${crypto.randomBytes(24).toString("hex")}`;
}

/** Constant-time compare so key checks don't leak length/prefix by timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function findConnection(
  cfg: Config,
  key: string | undefined | null,
): AgentConnection | null {
  if (!key) return null;
  for (const conn of cfg.agent_connections) {
    if (conn.key && safeEqual(conn.key, key)) return conn;
  }
  return null;
}

export function createConnection(
  cfg: Config,
  name: string,
  vault: string,
  permissions: Permission[] = ALL_PERMISSIONS,
): AgentConnection {
  const conn: AgentConnection = {
    key: generateKey(),
    name,
    vault,
    permissions: permissions.length ? permissions : ALL_PERMISSIONS,
    created: new Date().toISOString(),
    last_used: null,
  };
  cfg.agent_connections.push(conn);
  saveConfig(cfg);
  return conn;
}

export function revokeConnection(cfg: Config, key: string): boolean {
  const before = cfg.agent_connections.length;
  cfg.agent_connections = cfg.agent_connections.filter((c) => c.key !== key);
  const removed = cfg.agent_connections.length < before;
  if (removed) saveConfig(cfg);
  return removed;
}

export function rotateConnection(cfg: Config, key: string): AgentConnection | null {
  const conn = cfg.agent_connections.find((c) => c.key === key);
  if (!conn) return null;
  conn.key = generateKey();
  conn.last_used = null;
  saveConfig(cfg);
  return conn;
}

export function setPermissions(
  cfg: Config,
  key: string,
  permissions: Permission[],
): AgentConnection | null {
  const conn = cfg.agent_connections.find((c) => c.key === key);
  if (!conn) return null;
  conn.permissions = permissions.filter((p) => ALL_PERMISSIONS.includes(p));
  saveConfig(cfg);
  return conn;
}

export function touchConnection(cfg: Config, key: string): void {
  const conn = cfg.agent_connections.find((c) => c.key === key);
  if (!conn) return;
  conn.last_used = new Date().toISOString();
  saveConfig(cfg);
}

export function hasPermission(
  conn: AgentConnection | null,
  permission: Permission,
): boolean {
  if (!conn) return true; // stdio transport: the parent process is already trusted
  return conn.permissions.includes(permission);
}

export function assertPermission(
  conn: AgentConnection | null,
  permission: Permission,
): void {
  if (!hasPermission(conn, permission)) {
    throw new Error(
      `This agent connection ("${conn?.name}") lacks "${permission}" permission. Grant it in the dashboard under Settings.`,
    );
  }
}

/** Mask a key for display: sk-1a2b…9f8e */
export function maskKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

export function extractKey(req: Request): string | null {
  const header = req.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const apiKey = req.get("x-api-key");
  if (apiKey) return apiKey.trim();
  const q = req.query?.key;
  if (typeof q === "string" && q) return q;
  return null;
}

export interface AuthedRequest extends Request {
  /** Set by requireAuth: the agent connection this request authenticated as. */
  agent?: AgentConnection | null;
}

function isLoopback(req: Request): boolean {
  const ip = (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

/**
 * Express middleware.
 *
 * A valid API key always passes. Requests from this machine's loopback
 * interface also pass when `allowLoopback` is set — that's how the local
 * dashboard talks to its own API without shipping a key into the browser.
 * Anything off-box without a key gets a 401.
 */
export function requireAuth(options: { allowLoopback?: boolean } = {}) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const cfg = loadConfig();
    const key = extractKey(req);
    const conn = findConnection(cfg, key);

    if (conn) {
      req.agent = conn;
      touchConnection(cfg, conn.key);
      next();
      return;
    }

    if (key) {
      res.status(401).json({ error: "Invalid API key." });
      return;
    }

    if (options.allowLoopback && isLoopback(req)) {
      req.agent = null;
      next();
      return;
    }

    res.status(401).json({
      error:
        "Missing API key. Send it as `Authorization: Bearer <key>` or `x-api-key: <key>`.",
    });
  };
}
