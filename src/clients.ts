/**
 * One-click connect.
 *
 * The whole point of the plugin: a user should never open a JSON file to wire
 * an agent to their vault. We know where each client keeps its MCP config, so
 * we detect the ones that are installed, merge our entry into their config,
 * and leave a .bak behind in case we got it wrong.
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export type ClientId = "claude-desktop" | "claude-code" | "cursor" | "vscode" | "windsurf";

export interface ClientDefinition {
  id: ClientId;
  name: string;
  /** Where the MCP config lives on this platform, or null if unsupported. */
  configPath: () => string | null;
  /** Top-level key holding the server map. VS Code uses "servers". */
  serversKey: string;
  /** Shown when the client can't be auto-configured. */
  note?: string;
}

export interface ClientState {
  definition: ClientDefinition;
  configPath: string | null;
  /** The config file, or the app's config folder, exists on disk. */
  installed: boolean;
  /** Gate is already present in that config, pointing at this URL. */
  connected: boolean;
}

function appData(): string | null {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support");
    case "win32":
      return process.env.APPDATA ?? join(home, "AppData", "Roaming");
    default:
      return join(home, ".config");
  }
}

export const CLIENTS: ClientDefinition[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    serversKey: "mcpServers",
    configPath: () => {
      const base = appData();
      return base ? join(base, "Claude", "claude_desktop_config.json") : null;
    },
    note: "Requires Claude Desktop 0.11 or newer for local HTTP servers.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    serversKey: "mcpServers",
    configPath: () => join(homedir(), ".claude.json"),
  },
  {
    id: "cursor",
    name: "Cursor",
    serversKey: "mcpServers",
    configPath: () => join(homedir(), ".cursor", "mcp.json"),
  },
  {
    id: "vscode",
    name: "VS Code (Copilot)",
    serversKey: "servers",
    configPath: () => {
      const base = appData();
      return base ? join(base, "Code", "User", "mcp.json") : null;
    },
  },
  {
    id: "windsurf",
    name: "Windsurf",
    serversKey: "mcpServers",
    configPath: () => join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
  },
];

export interface Connection {
  /** Key the server is filed under in the client's config. */
  serverName: string;
  url: string;
  token: string;
}

export function serverEntry(conn: Connection): Record<string, unknown> {
  return {
    type: "http",
    url: conn.url,
    headers: { Authorization: `Bearer ${conn.token}` },
  };
}

/** The snippet shown in settings for clients we can't write to automatically. */
export function manualSnippet(conn: Connection): string {
  return JSON.stringify(
    { mcpServers: { [conn.serverName]: serverEntry(conn) } },
    null,
    2,
  );
}

function parentDir(path: string): string {
  return path.split(/[\\/]/).slice(0, -1).join(platform() === "win32" ? "\\" : "/");
}

/**
 * JSON with comments — VS Code's mcp.json and some Cursor configs allow them,
 * and JSON.parse does not. Strip them rather than refusing to touch the file.
 */
function parseLooseJson(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, (m, str) => str || "")
    .replace(/,(\s*[}\]])/g, "$1");
  const parsed = JSON.parse(stripped || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config file is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").trim();
  if (!text) return {};
  return parseLooseJson(text);
}

/** Inspect every known client without touching anything. */
export function detectClients(conn: Connection): ClientState[] {
  return CLIENTS.map((definition) => {
    const configPath = definition.configPath();
    let installed = false;
    let connected = false;

    if (configPath) {
      const dir = parentDir(configPath);
      installed = existsSync(configPath) || existsSync(dir);
      try {
        const servers = readConfig(configPath)[definition.serversKey];
        const entry =
          servers && typeof servers === "object"
            ? (servers as Record<string, any>)[conn.serverName]
            : null;
        connected = !!entry && entry.url === conn.url;
      } catch {
        connected = false;
      }
    }
    return { definition, configPath, installed, connected };
  });
}

export interface ConnectResult {
  ok: boolean;
  path: string | null;
  message: string;
}

/** Merge Gate into one client's config. Idempotent — re-running just refreshes the token. */
export function connectClient(
  definition: ClientDefinition,
  conn: Connection,
): ConnectResult {
  const path = definition.configPath();
  if (!path) {
    return { ok: false, path: null, message: `${definition.name} is not supported on this platform.` };
  }

  try {
    const config = readConfig(path);
    const existing = config[definition.serversKey];
    const servers: Record<string, unknown> =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};

    servers[conn.serverName] = serverEntry(conn);
    config[definition.serversKey] = servers;

    writeConfig(path, config);
    return {
      ok: true,
      path,
      message: `Connected. Restart ${definition.name} to pick it up.`,
    };
  } catch (err) {
    return {
      ok: false,
      path,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Remove Gate from one client's config, leaving everything else alone. */
export function disconnectClient(
  definition: ClientDefinition,
  conn: Connection,
): ConnectResult {
  const path = definition.configPath();
  if (!path || !existsSync(path)) {
    return { ok: true, path, message: "Nothing to disconnect." };
  }

  try {
    const config = readConfig(path);
    const servers = config[definition.serversKey];
    if (servers && typeof servers === "object") {
      delete (servers as Record<string, unknown>)[conn.serverName];
    }
    writeConfig(path, config);
    return { ok: true, path, message: `Removed from ${definition.name}.` };
  } catch (err) {
    return { ok: false, path, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Back up, then replace via a temp file. We are editing config the user did
 * not ask us to own — a half-written claude_desktop_config.json would break
 * their whole setup, not just Gate.
 */
function writeConfig(path: string, config: Record<string, unknown>): void {
  const dir = parentDir(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.gate-backup`);

  const tmp = `${path}.gate-tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
