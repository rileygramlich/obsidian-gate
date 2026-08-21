#!/usr/bin/env node
/**
 * CLI entry point — `npx obsidian-agent`.
 *
 *   obsidian-agent            start the dashboard + MCP HTTP endpoint
 *   obsidian-agent --mcp      speak MCP over stdio (what agents launch)
 *   obsidian-agent init       interactive setup wizard
 *   obsidian-agent keys ...   manage agent API keys
 *   obsidian-agent doctor     verify the vault, key auth and every tool
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  configPath,
  defaultConfig,
  expandHome,
  getVault,
  loadConfig,
  saveConfig,
  readActivity,
  type Config,
} from "./config.js";
import { createConnection, maskKey, revokeConnection, rotateConnection, ALL_PERMISSIONS } from "./auth.js";
import { licenseSummary, validateLicense } from "./license.js";
import { callTool, createMcpServer, TOOL_DEFINITIONS, SERVER_VERSION } from "./mcp-server.js";
import { startDashboard } from "./dashboard.js";
import { Vault } from "./vault.js";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  purple: "\x1b[35m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

const say = (...args: unknown[]) => console.log(...args);
const ok = (msg: string) => say(`${c.green}✓${c.reset} ${msg}`);
const bad = (msg: string) => say(`${c.red}✗${c.reset} ${msg}`);

function banner(): void {
  say(`${c.purple}${c.bold}
  ┌─────────────────────────────────────────┐
  │  Obsidian Agent Connector  v${SERVER_VERSION}        │
  │  Your vault, readable by any AI agent   │
  └─────────────────────────────────────────┘${c.reset}`);
}

/* ------------------------------------------------------------------ */
/* MCP over stdio                                                      */
/* ------------------------------------------------------------------ */

async function runStdioServer(vaultName?: string): Promise<void> {
  const cfg = loadConfig(true);
  await validateLicense(cfg).catch(() => undefined);
  const server = createMcpServer({ connection: null, vaultName: vaultName ?? null });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the protocol; anything human-readable goes to stderr.
  console.error(`[obsidian-agent] MCP stdio server ready (${TOOL_DEFINITIONS.length} tools)`);
}

/* ------------------------------------------------------------------ */
/* init wizard                                                         */
/* ------------------------------------------------------------------ */

async function runInit(): Promise<void> {
  banner();
  const rl = readline.createInterface({ input, output });
  const cfg = fs.existsSync(configPath()) ? loadConfig(true) : defaultConfig();

  try {
    say(`${c.dim}Config file: ${configPath()}${c.reset}\n`);

    const defaultPath = cfg.vaults[0]?.path || "";
    const answer = (await rl.question(
      `Path to your Obsidian vault${defaultPath ? ` [${defaultPath}]` : ""}: `,
    )).trim();
    const vaultPath = path.resolve(expandHome(answer || defaultPath));
    if (!vaultPath || !fs.existsSync(vaultPath)) {
      bad(`No folder at ${vaultPath || "(empty)"} — create the vault first, then rerun init.`);
      process.exitCode = 1;
      return;
    }

    const defaultName = cfg.vaults[0]?.name || path.basename(vaultPath);
    const name =
      (await rl.question(`Vault name [${defaultName}]: `)).trim() || defaultName;

    const defaultDaily = cfg.vaults[0]?.daily_notes_path || "01-Daily/";
    const daily =
      (await rl.question(`Daily notes folder [${defaultDaily}]: `)).trim() || defaultDaily;

    const agentDefault = "Claude Code";
    const agentName =
      (await rl.question(`Name this agent connection [${agentDefault}]: `)).trim() ||
      agentDefault;

    cfg.vaults = [
      {
        name,
        path: vaultPath,
        daily_notes_path: daily,
        frontmatter_template: cfg.vaults[0]?.frontmatter_template ?? {
          created: "{{date}}",
          tags: [],
        },
      },
      ...cfg.vaults.filter((v) => v.path !== vaultPath).slice(0, 2),
    ];
    saveConfig(cfg);

    const conn = createConnection(cfg, agentName, name, ALL_PERMISSIONS);

    say("");
    ok(`Vault registered: ${c.bold}${name}${c.reset} → ${vaultPath}`);

    const vault = new Vault(cfg.vaults[0]);
    const stats = await vault.stats();
    ok(`Found ${stats.notes} notes in ${stats.folders} folders`);
    ok(`API key generated: ${c.bold}${conn.key}${c.reset}`);
    say(`${c.dim}  (stored in ${configPath()} — treat it like a password)${c.reset}`);

    say(`\n${c.bold}Add this to your MCP client config:${c.reset}`);
    say(
      `${c.green}${JSON.stringify(
        { mcpServers: { obsidian: { command: "npx", args: ["obsidian-agent", "--mcp"] } } },
        null,
        2,
      )}${c.reset}`,
    );
    say(`\nOr over HTTP (dashboard must be running):`);
    say(
      `${c.green}${JSON.stringify(
        {
          mcpServers: {
            obsidian: {
              type: "http",
              url: `http://localhost:${cfg.settings.port}/mcp`,
              headers: { Authorization: `Bearer ${conn.key}` },
            },
          },
        },
        null,
        2,
      )}${c.reset}`,
    );

    say(`\nNext: ${c.bold}npx obsidian-agent${c.reset} → dashboard at http://localhost:${cfg.settings.port}`);
  } finally {
    rl.close();
  }
}

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

async function runDoctor(): Promise<void> {
  banner();
  const cfg = loadConfig(true);
  let failures = 0;
  const check = (pass: boolean, msg: string) => {
    if (pass) ok(msg);
    else {
      bad(msg);
      failures++;
    }
  };

  check(fs.existsSync(configPath()), `Config file present (${configPath()})`);
  check(cfg.vaults.length > 0, `Vault configured (${cfg.vaults.length})`);
  if (!cfg.vaults.length) {
    say(`\n${c.yellow}Run \`obsidian-agent init\` first.${c.reset}`);
    process.exitCode = 1;
    return;
  }

  const vault = new Vault(getVault(cfg));
  try {
    vault.assertExists();
    const stats = await vault.stats();
    ok(`Vault readable: ${vault.root} (${stats.notes} notes)`);
  } catch (err) {
    check(false, `Vault readable: ${(err as Error).message}`);
  }

  check(cfg.agent_connections.length > 0, `Agent connections: ${cfg.agent_connections.length}`);

  const list = await callTool("list_notes", {});
  check(!list.isError, "Tool list_notes works");
  const tags = await callTool("get_tags", {});
  check(!tags.isError, "Tool get_tags works");
  const search = await callTool("search_notes", { query: "the", limit: 3 });
  check(!search.isError, "Tool search_notes works");

  const license = licenseSummary(cfg);
  say(
    `\n${c.bold}Plan:${c.reset} ${license.label} (${license.price}) — ` +
      `${license.usage.queries} queries this month` +
      (license.limits.queries_per_month ? ` / ${license.limits.queries_per_month}` : " (unlimited)"),
  );

  say(
    failures === 0
      ? `\n${c.green}All checks passed.${c.reset} ${TOOL_DEFINITIONS.length} MCP tools ready.`
      : `\n${c.red}${failures} check(s) failed.${c.reset}`,
  );
  if (failures) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* serve                                                               */
/* ------------------------------------------------------------------ */

async function runServe(portOpt?: string): Promise<void> {
  banner();
  const cfg = loadConfig(true);
  if (!cfg.vaults.length) {
    say(`${c.yellow}No vault configured yet.${c.reset} Run ${c.bold}npx obsidian-agent init${c.reset} first.\n`);
  }
  const port = portOpt ? Number(portOpt) : cfg.settings.port;
  const { port: bound } = await startDashboard(port);
  const license = licenseSummary(loadConfig(true));

  ok(`Dashboard   http://localhost:${bound}/dashboard`);
  ok(`MCP (HTTP)  http://localhost:${bound}/mcp  ${c.dim}(Authorization: Bearer <key>)${c.reset}`);
  ok(`MCP (stdio) npx obsidian-agent --mcp`);
  say(`${c.dim}Plan: ${license.label} · vault${cfg.vaults.length === 1 ? "" : "s"}: ${cfg.vaults.map((v) => v.name).join(", ") || "none"}${c.reset}`);
  say(`${c.dim}Press Ctrl+C to stop.${c.reset}`);
}

/* ------------------------------------------------------------------ */
/* CLI wiring                                                          */
/* ------------------------------------------------------------------ */

const program = new Command();
program
  .name("obsidian-agent")
  .description("MCP server that connects AI agents to your Obsidian vault")
  .version(SERVER_VERSION)
  .option("--mcp", "run as an MCP server over stdio")
  .option("--vault <name>", "vault to serve")
  .option("-p, --port <port>", "port for the dashboard + MCP HTTP endpoint");

program
  .command("init")
  .description("interactive setup: vault path, API key, MCP config")
  .action(runInit);

program
  .command("serve", { isDefault: true })
  .description("start the dashboard and MCP HTTP endpoint")
  .option("-p, --port <port>", "port to listen on")
  .action(async (opts: { port?: string }) => {
    const globals = program.opts<{ mcp?: boolean; vault?: string; port?: string }>();
    if (globals.mcp) return runStdioServer(globals.vault);
    return runServe(opts.port ?? globals.port);
  });

program
  .command("mcp")
  .description("run as an MCP server over stdio")
  .option("--vault <name>", "vault to serve")
  .action((opts: { vault?: string }) => runStdioServer(opts.vault));

program.command("doctor").description("verify vault access and all MCP tools").action(runDoctor);

const keys = program.command("keys").description("manage agent API keys");
keys
  .command("list", { isDefault: true })
  .description("list agent connections")
  .action(() => {
    const cfg = loadConfig(true);
    if (!cfg.agent_connections.length) return say("No agent connections yet. Run `obsidian-agent init`.");
    for (const conn of cfg.agent_connections) {
      say(
        `${c.bold}${conn.name}${c.reset}  ${maskKey(conn.key)}  vault=${conn.vault}  ` +
          `perms=${conn.permissions.join(",")}  last_used=${conn.last_used ?? "never"}`,
      );
    }
  });
keys
  .command("new <name>")
  .description("create a new agent connection")
  .option("--vault <vault>", "vault name")
  .option("--permissions <list>", "comma-separated: read,write,search", "read,write,search")
  .action((name: string, opts: { vault?: string; permissions: string }) => {
    const cfg = loadConfig(true);
    const vault = opts.vault ?? cfg.vaults[0]?.name ?? "";
    const perms = opts.permissions.split(",").map((p) => p.trim()) as any;
    const conn = createConnection(cfg, name, vault, perms);
    ok(`Created key for ${name}: ${c.bold}${conn.key}${c.reset}`);
  });
keys
  .command("rotate <keyOrSuffix>")
  .description("rotate an existing key")
  .action((id: string) => {
    const cfg = loadConfig(true);
    const conn = cfg.agent_connections.find((k) => k.key === id || k.key.endsWith(id));
    if (!conn) return bad("No matching key.");
    const rotated = rotateConnection(cfg, conn.key)!;
    ok(`New key for ${rotated.name}: ${c.bold}${rotated.key}${c.reset}`);
  });
keys
  .command("revoke <keyOrSuffix>")
  .description("revoke a key")
  .action((id: string) => {
    const cfg = loadConfig(true);
    const conn = cfg.agent_connections.find((k) => k.key === id || k.key.endsWith(id));
    if (!conn) return bad("No matching key.");
    revokeConnection(cfg, conn.key);
    ok(`Revoked key for ${conn.name}.`);
  });

const vaults = program.command("vault").description("manage vaults");
vaults
  .command("list", { isDefault: true })
  .action(() => {
    const cfg = loadConfig(true);
    if (!cfg.vaults.length) return say("No vaults configured.");
    for (const v of cfg.vaults) say(`${c.bold}${v.name}${c.reset}  ${v.path}  daily=${v.daily_notes_path}`);
  });
vaults
  .command("add <name> <vaultPath>")
  .option("--daily <folder>", "daily notes folder", "01-Daily/")
  .action((name: string, vaultPath: string, opts: { daily: string }) => {
    const cfg = loadConfig(true);
    const resolved = path.resolve(expandHome(vaultPath));
    if (!fs.existsSync(resolved)) return bad(`No folder at ${resolved}`);
    cfg.vaults.push({
      name,
      path: resolved,
      daily_notes_path: opts.daily,
      frontmatter_template: { created: "{{date}}", tags: [] },
    });
    saveConfig(cfg);
    ok(`Added vault ${name} → ${resolved}`);
  });
vaults
  .command("remove <name>")
  .action((name: string) => {
    const cfg = loadConfig(true);
    cfg.vaults = cfg.vaults.filter((v) => v.name !== name);
    saveConfig(cfg);
    ok(`Removed vault ${name}.`);
  });

const license = program.command("license").description("manage your subscription license");
license
  .command("status", { isDefault: true })
  .action(async () => {
    const cfg = loadConfig(true);
    await validateLicense(cfg).catch(() => undefined);
    const s = licenseSummary(loadConfig(true));
    say(`${c.bold}Plan:${c.reset} ${s.label} (${s.price}) — status: ${s.status}`);
    say(
      `Usage this month: ${s.usage.queries} queries` +
        (s.limits.queries_per_month ? ` / ${s.limits.queries_per_month}` : " (unlimited)") +
        `, ${s.usage.notes_created} notes created by agents`,
    );
  });
license
  .command("set <key>")
  .description("activate a license key from checkout")
  .action(async (key: string) => {
    const cfg = loadConfig(true);
    cfg.license.key = key;
    cfg.license.checked_at = null;
    saveConfig(cfg);
    const state = await validateLicense(cfg, { force: true });
    if (state.status === "inactive") bad("That license key could not be validated.");
    else ok(`License active: ${state.tier} tier.`);
  });

program
  .command("activity")
  .description("show recent agent activity")
  .option("-n, --limit <n>", "entries to show", "20")
  .action((opts: { limit: string }) => {
    const entries = readActivity(Number(opts.limit));
    if (!entries.length) return say("No agent activity recorded yet.");
    for (const e of entries) {
      say(
        `${c.dim}${e.ts}${c.reset}  ${e.ok ? c.green + "ok " : c.red + "err"}${c.reset}  ` +
          `${c.bold}${e.agent}${c.reset}  ${e.tool}  ${c.dim}${e.summary}${c.reset}`,
      );
    }
  });

program
  .command("tools")
  .description("print the MCP tool definitions")
  .action(() => say(JSON.stringify(TOOL_DEFINITIONS, null, 2)));

// `--mcp` must work as a bare global flag, before commander picks a subcommand.
if (process.argv.includes("--mcp")) {
  const vaultIdx = process.argv.indexOf("--vault");
  runStdioServer(vaultIdx > -1 ? process.argv[vaultIdx + 1] : undefined).catch((err) => {
    console.error("[obsidian-agent] fatal:", err);
    process.exit(1);
  });
} else {
  program.parseAsync(process.argv).catch((err: unknown) => {
    bad(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export type { Config };
