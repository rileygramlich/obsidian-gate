/**
 * Config management for Obsidian Agent Connector.
 *
 * Everything is local. The source of truth is ~/.obsidian-gate/config.json,
 * with env vars layered on top for one-off overrides. No database, no cloud.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_VERSION = 1;

export interface VaultConfig {
  name: string;
  path: string;
  daily_notes_path: string;
  frontmatter_template: Record<string, unknown>;
}

export type Permission = "read" | "write" | "search";

export interface AgentConnection {
  key: string;
  name: string;
  vault: string;
  permissions: Permission[];
  created?: string;
  last_used: string | null;
}

export interface Settings {
  port: number;
  log_level: "debug" | "info" | "warn" | "error";
  max_search_results: number;
}

export interface LicenseState {
  key: string | null;
  tier: "free" | "personal" | "team";
  status: "active" | "trialing" | "inactive";
  checked_at: string | null;
  customer_id?: string | null;
  subscription_id?: string | null;
}

export interface UsageState {
  month: string; // YYYY-MM
  queries: number;
  notes_created: number;
  tokens: number;
}

export interface Config {
  version: number;
  vaults: VaultConfig[];
  agent_connections: AgentConnection[];
  settings: Settings;
  license: LicenseState;
  usage: UsageState;
}

export interface ActivityEntry {
  ts: string;
  agent: string;
  tool: string;
  summary: string;
  vault?: string;
  ok: boolean;
  tokens?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 3100,
  log_level: "info",
  max_search_results: 50,
};

export function configHome(): string {
  return (
    process.env.OBSIDIAN_AGENT_HOME || path.join(os.homedir(), ".obsidian-gate")
  );
}

export function configPath(): string {
  return path.join(configHome(), "config.json");
}

export function activityPath(): string {
  return path.join(configHome(), "activity.jsonl");
}

export function currentMonth(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    vaults: [],
    agent_connections: [],
    settings: { ...DEFAULT_SETTINGS },
    license: {
      key: null,
      tier: "free",
      status: "inactive",
      checked_at: null,
      customer_id: null,
      subscription_id: null,
    },
    usage: { month: currentMonth(), queries: 0, notes_created: 0, tokens: 0 },
  };
}

/** Bring older config shapes up to CONFIG_VERSION without losing data. */
export function migrateConfig(raw: any): Config {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;

  const cfg: Config = {
    version: CONFIG_VERSION,
    vaults: Array.isArray(raw.vaults)
      ? raw.vaults.map((v: any) => ({
          name: String(v?.name ?? "Vault"),
          path: expandHome(String(v?.path ?? "")),
          daily_notes_path: String(v?.daily_notes_path ?? ""),
          frontmatter_template:
            v?.frontmatter_template && typeof v.frontmatter_template === "object"
              ? v.frontmatter_template
              : { created: "{{date}}", tags: [] },
        }))
      : [],
    agent_connections: Array.isArray(raw.agent_connections)
      ? raw.agent_connections.map((c: any) => ({
          key: String(c?.key ?? ""),
          name: String(c?.name ?? "Agent"),
          vault: String(c?.vault ?? ""),
          permissions: normalizePermissions(c?.permissions),
          created: c?.created ?? null,
          last_used: c?.last_used ?? null,
        }))
      : [],
    settings: {
      port: numberOr(raw?.settings?.port, base.settings.port),
      log_level: ["debug", "info", "warn", "error"].includes(
        raw?.settings?.log_level,
      )
        ? raw.settings.log_level
        : base.settings.log_level,
      max_search_results: numberOr(
        raw?.settings?.max_search_results,
        base.settings.max_search_results,
      ),
    },
    license: {
      key: raw?.license?.key ?? null,
      tier: ["free", "personal", "team"].includes(raw?.license?.tier)
        ? raw.license.tier
        : "free",
      status: ["active", "trialing", "inactive"].includes(raw?.license?.status)
        ? raw.license.status
        : "inactive",
      checked_at: raw?.license?.checked_at ?? null,
      customer_id: raw?.license?.customer_id ?? null,
      subscription_id: raw?.license?.subscription_id ?? null,
    },
    usage: {
      month: raw?.usage?.month ?? currentMonth(),
      queries: numberOr(raw?.usage?.queries, 0),
      notes_created: numberOr(raw?.usage?.notes_created, 0),
      tokens: numberOr(raw?.usage?.tokens, 0),
    },
  };

  // Usage counters reset at the start of each calendar month.
  if (cfg.usage.month !== currentMonth()) {
    cfg.usage = { month: currentMonth(), queries: 0, notes_created: 0, tokens: 0 };
  }
  return cfg;
}

function numberOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePermissions(v: unknown): Permission[] {
  const all: Permission[] = ["read", "write", "search"];
  if (!Array.isArray(v)) return ["read", "search"];
  const out = v.filter((p): p is Permission => all.includes(p as Permission));
  return out.length ? Array.from(new Set(out)) : ["read", "search"];
}

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

let cached: Config | null = null;

export function loadConfig(force = false): Config {
  if (cached && !force) return cached;
  let raw: any = null;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    raw = null;
  }
  const cfg = migrateConfig(raw);
  applyEnvOverrides(cfg);
  cached = cfg;
  return cfg;
}

function applyEnvOverrides(cfg: Config): void {
  if (process.env.PORT) cfg.settings.port = Number(process.env.PORT);
  if (process.env.OBSIDIAN_AGENT_LICENSE) {
    cfg.license.key = process.env.OBSIDIAN_AGENT_LICENSE;
  }
  const envVault = process.env.OBSIDIAN_VAULT_PATH;
  if (envVault) {
    const resolved = expandHome(envVault);
    const existing = cfg.vaults.find((v) => v.path === resolved);
    if (!existing) {
      cfg.vaults.unshift({
        name: path.basename(resolved) || "Vault",
        path: resolved,
        daily_notes_path: "01-Daily/",
        frontmatter_template: { created: "{{date}}", tags: [] },
      });
    }
  }
}

export function saveConfig(cfg: Config): void {
  const dir = configHome();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, configPath());
  cached = cfg;
}

export function configExists(): boolean {
  return fs.existsSync(configPath());
}

/** Resolve a vault by name; falls back to the first configured vault. */
export function getVault(cfg: Config, name?: string | null): VaultConfig {
  if (!cfg.vaults.length) {
    throw new Error(
      "No vault configured. Run `obsidian-gate init` to point the connector at your Obsidian vault.",
    );
  }
  if (!name) return cfg.vaults[0];
  const found = cfg.vaults.find(
    (v) => v.name.toLowerCase() === name.toLowerCase(),
  );
  if (!found) {
    throw new Error(
      `Unknown vault "${name}". Configured vaults: ${cfg.vaults
        .map((v) => v.name)
        .join(", ")}`,
    );
  }
  return found;
}

export function addVault(cfg: Config, vault: VaultConfig): Config {
  const idx = cfg.vaults.findIndex(
    (v) => v.name.toLowerCase() === vault.name.toLowerCase(),
  );
  if (idx >= 0) cfg.vaults[idx] = vault;
  else cfg.vaults.push(vault);
  saveConfig(cfg);
  return cfg;
}

export function removeVault(cfg: Config, name: string): Config {
  cfg.vaults = cfg.vaults.filter(
    (v) => v.name.toLowerCase() !== name.toLowerCase(),
  );
  saveConfig(cfg);
  return cfg;
}

/* ------------------------------------------------------------------ */
/* Activity log — append-only JSONL next to the config file.           */
/* ------------------------------------------------------------------ */

const MAX_ACTIVITY_LINES = 2000;

export function logActivity(entry: Omit<ActivityEntry, "ts">): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    fs.mkdirSync(configHome(), { recursive: true });
    fs.appendFileSync(activityPath(), line + "\n");
    trimActivity();
  } catch {
    // Activity logging is best-effort; never break a tool call over it.
  }
}

function trimActivity(): void {
  try {
    const stat = fs.statSync(activityPath());
    if (stat.size < 512 * 1024) return;
    const lines = fs
      .readFileSync(activityPath(), "utf8")
      .split("\n")
      .filter(Boolean);
    fs.writeFileSync(
      activityPath(),
      lines.slice(-MAX_ACTIVITY_LINES).join("\n") + "\n",
    );
  } catch {
    /* ignore */
  }
}

export function readActivity(limit = 50): ActivityEntry[] {
  try {
    const lines = fs
      .readFileSync(activityPath(), "utf8")
      .split("\n")
      .filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as ActivityEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ActivityEntry => e !== null)
      .reverse();
  } catch {
    return [];
  }
}

/** Count a billable operation against the current month's usage. */
export function recordUsage(
  cfg: Config,
  kind: "query" | "note_created",
  tokens = 0,
): Config {
  if (cfg.usage.month !== currentMonth()) {
    cfg.usage = { month: currentMonth(), queries: 0, notes_created: 0, tokens: 0 };
  }
  if (kind === "query") cfg.usage.queries += 1;
  if (kind === "note_created") cfg.usage.notes_created += 1;
  cfg.usage.tokens += tokens;
  saveConfig(cfg);
  return cfg;
}

export function log(
  cfg: Config,
  level: Settings["log_level"],
  ...args: unknown[]
): void {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  if (order[level] < order[cfg.settings.log_level]) return;
  // stderr keeps stdout clean for the stdio MCP transport.
  console.error(`[obsidian-gate] ${level}:`, ...args);
}
