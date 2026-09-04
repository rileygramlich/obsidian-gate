/**
 * Plugin settings: shape, defaults, and token generation.
 */
import type { Permission } from "./tools";

export interface GateSettings {
  /** Start the server when Obsidian starts. */
  autoStart: boolean;
  port: number;
  token: string;
  /** Name agents see, and the key used in each client's config file. */
  serverName: string;
  permissions: Permission[];
  dailyNotesFolder: string;
  frontmatterTemplate: Record<string, unknown>;
  maxSearchResults: number;
  showStatusBar: boolean;
  /** Cleared once the user finishes (or dismisses) the first-run wizard. */
  needsSetup: boolean;
}

export const DEFAULT_SETTINGS: GateSettings = {
  autoStart: true,
  port: 22360,
  token: "",
  serverName: "obsidian",
  permissions: ["read", "search"],
  dailyNotesFolder: "",
  frontmatterTemplate: { created: "{{date}}" },
  maxSearchResults: 50,
  showStatusBar: true,
  needsSetup: true,
};

/**
 * A URL-safe random token. `crypto` is the Web Crypto global Electron
 * provides, so this works without a Node import.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `gate_${hex}`;
}

export function endpointUrl(settings: GateSettings): string {
  return `http://127.0.0.1:${settings.port}/mcp`;
}

/** Fill in anything missing or invalid in loaded data. */
export function normalizeSettings(raw: unknown): GateSettings {
  const data = (raw && typeof raw === "object" ? raw : {}) as Partial<GateSettings>;
  const port = Number(data.port);
  const permissions = Array.isArray(data.permissions)
    ? data.permissions.filter((p): p is Permission =>
        ["read", "write", "search"].includes(p as string),
      )
    : DEFAULT_SETTINGS.permissions;

  return {
    ...DEFAULT_SETTINGS,
    ...data,
    port: Number.isInteger(port) && port > 1023 && port < 65536 ? port : DEFAULT_SETTINGS.port,
    permissions: permissions.length ? permissions : DEFAULT_SETTINGS.permissions,
    token: typeof data.token === "string" && data.token ? data.token : generateToken(),
    serverName:
      typeof data.serverName === "string" && data.serverName.trim()
        ? data.serverName.trim()
        : DEFAULT_SETTINGS.serverName,
    maxSearchResults:
      Number(data.maxSearchResults) > 0
        ? Number(data.maxSearchResults)
        : DEFAULT_SETTINGS.maxSearchResults,
    frontmatterTemplate:
      data.frontmatterTemplate && typeof data.frontmatterTemplate === "object"
        ? data.frontmatterTemplate
        : DEFAULT_SETTINGS.frontmatterTemplate,
  };
}
