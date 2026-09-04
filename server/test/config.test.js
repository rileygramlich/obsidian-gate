/** Config loading, migration, env overrides and vault resolution. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useTempHome, makeVault, rm } from "./helpers.js";

const home = useTempHome();

const {
  CONFIG_VERSION,
  defaultConfig,
  migrateConfig,
  loadConfig,
  saveConfig,
  configExists,
  configPath,
  expandHome,
  currentMonth,
  getVault,
  addVault,
  removeVault,
  recordUsage,
} = await import("../dist/config.js");

test.after(() => rm(home));

test("defaultConfig is a valid empty config", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.version, CONFIG_VERSION);
  assert.deepEqual(cfg.vaults, []);
  assert.equal(cfg.license.tier, "free");
  assert.equal(cfg.license.status, "inactive");
  assert.equal(cfg.usage.queries, 0);
  assert.equal(cfg.usage.month, currentMonth());
});

test("migrateConfig falls back to defaults on junk input", () => {
  for (const junk of [null, undefined, 42, "nope", []]) {
    const cfg = migrateConfig(junk);
    assert.equal(cfg.version, CONFIG_VERSION);
    assert.deepEqual(cfg.vaults, []);
  }
});

test("migrateConfig preserves vaults and expands ~ in paths", () => {
  const cfg = migrateConfig({
    vaults: [{ name: "Mine", path: "~/Notes", daily_notes_path: "Daily/" }],
  });
  assert.equal(cfg.vaults.length, 1);
  assert.equal(cfg.vaults[0].path, path.join(os.homedir(), "Notes"));
  // A vault missing its template still gets a usable one.
  assert.ok(cfg.vaults[0].frontmatter_template);
});

test("migrateConfig normalizes bad permissions to read+search", () => {
  const cfg = migrateConfig({
    agent_connections: [{ key: "k", name: "A", vault: "V", permissions: ["write", "bogus"] }],
  });
  assert.deepEqual(cfg.agent_connections[0].permissions, ["write"]);

  const empty = migrateConfig({
    agent_connections: [{ key: "k", name: "A", vault: "V", permissions: "nope" }],
  });
  assert.deepEqual(empty.agent_connections[0].permissions, ["read", "search"]);
});

test("migrateConfig resets usage counters when the month rolls over", () => {
  const cfg = migrateConfig({
    usage: { month: "2020-01", queries: 999, notes_created: 5, tokens: 10 },
  });
  assert.equal(cfg.usage.month, currentMonth());
  assert.equal(cfg.usage.queries, 0);
  assert.equal(cfg.usage.tokens, 0);
});

test("migrateConfig keeps usage inside the current month", () => {
  const cfg = migrateConfig({
    usage: { month: currentMonth(), queries: 7, notes_created: 2, tokens: 30 },
  });
  assert.equal(cfg.usage.queries, 7);
});

test("migrateConfig rejects out-of-range enum values", () => {
  const cfg = migrateConfig({
    settings: { log_level: "loud", port: "not-a-number" },
    license: { tier: "platinum", status: "maybe" },
  });
  assert.equal(cfg.settings.log_level, "info");
  assert.equal(cfg.settings.port, 3100);
  assert.equal(cfg.license.tier, "free");
  assert.equal(cfg.license.status, "inactive");
});

test("expandHome resolves ~ but leaves other paths alone", () => {
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"));
  assert.equal(expandHome("/abs/x"), "/abs/x");
  assert.equal(expandHome(""), "");
});

test("saveConfig writes 0600 and round-trips through loadConfig", () => {
  const cfg = defaultConfig();
  cfg.settings.max_search_results = 17;
  saveConfig(cfg);

  assert.ok(configExists());
  const mode = fs.statSync(configPath()).mode & 0o777;
  assert.equal(mode, 0o600, "config holds API keys and must not be world-readable");
  assert.equal(loadConfig(true).settings.max_search_results, 17);
});

test("env vars override the config file", () => {
  saveConfig(defaultConfig());
  process.env.PORT = "4321";
  process.env.OBSIDIAN_AGENT_LICENSE = "oa_live_team_abcdefgh";
  try {
    const cfg = loadConfig(true);
    assert.equal(cfg.settings.port, 4321);
    assert.equal(cfg.license.key, "oa_live_team_abcdefgh");
  } finally {
    delete process.env.PORT;
    delete process.env.OBSIDIAN_AGENT_LICENSE;
  }
});

test("OBSIDIAN_VAULT_PATH injects a vault without duplicating it", () => {
  const vault = makeVault();
  saveConfig(defaultConfig());
  process.env.OBSIDIAN_VAULT_PATH = vault.path;
  try {
    assert.equal(loadConfig(true).vaults.length, 1);
    assert.equal(loadConfig(true).vaults.length, 1, "reload must not append a second copy");
    assert.equal(loadConfig(true).vaults[0].path, vault.path);
  } finally {
    delete process.env.OBSIDIAN_VAULT_PATH;
    rm(vault.path);
  }
});

test("getVault resolves by name, case-insensitively, and defaults to the first", () => {
  const cfg = defaultConfig();
  cfg.vaults = [
    { name: "Work", path: "/tmp/work", daily_notes_path: "", frontmatter_template: {} },
    { name: "Personal", path: "/tmp/personal", daily_notes_path: "", frontmatter_template: {} },
  ];
  assert.equal(getVault(cfg).name, "Work");
  assert.equal(getVault(cfg, "personal").name, "Personal");
  assert.equal(getVault(cfg, "PERSONAL").name, "Personal");
  assert.throws(() => getVault(cfg, "nope"), /Unknown vault/);
});

test("getVault gives an actionable error when nothing is configured", () => {
  assert.throws(() => getVault(defaultConfig()), /obsidian-gate init/);
});

test("addVault replaces same-name entries instead of duplicating", () => {
  const cfg = defaultConfig();
  saveConfig(cfg);
  const v = makeVault();
  addVault(cfg, v);
  addVault(cfg, { ...v, path: "/tmp/moved" });
  assert.equal(cfg.vaults.length, 1);
  assert.equal(cfg.vaults[0].path, "/tmp/moved");

  removeVault(cfg, "testvault");
  assert.equal(cfg.vaults.length, 0, "removal is case-insensitive");
  rm(v.path);
});

test("recordUsage increments counters and rolls the month over", () => {
  const cfg = defaultConfig();
  saveConfig(cfg);
  recordUsage(cfg, "query", 10);
  recordUsage(cfg, "query", 5);
  recordUsage(cfg, "note_created");
  assert.equal(cfg.usage.queries, 2);
  assert.equal(cfg.usage.notes_created, 1);
  assert.equal(cfg.usage.tokens, 15);

  cfg.usage.month = "2020-01";
  cfg.usage.queries = 500;
  recordUsage(cfg, "query");
  assert.equal(cfg.usage.month, currentMonth());
  assert.equal(cfg.usage.queries, 1, "counters restart in a new month");
});
