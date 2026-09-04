/** Health check — the HTTP surface comes up and answers correctly. */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempHome, makeVault, rm, listen } from "./helpers.js";

const home = useTempHome();
const vaultCfg = makeVault();

const { defaultConfig, saveConfig } = await import("../dist/config.js");
const { createConnection } = await import("../dist/auth.js");

const cfg = defaultConfig();
cfg.vaults = [vaultCfg];
saveConfig(cfg);
const connection = createConnection(cfg, "Test Agent", vaultCfg.name);

const { createDashboardApp } = await import("../dist/dashboard.js");

const server = await listen(createDashboardApp());

test.after(async () => {
  await server.close();
  rm(home);
  rm(vaultCfg.path);
});

test("GET /api/status reports a healthy server", async () => {
  const res = await fetch(`${server.base}/api/status`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(body.server.version, "reports its version");
  assert.equal(typeof body.server.uptime_s, "number");
  assert.equal(body.vaults.length, 1);
  assert.equal(body.vaults[0].name, vaultCfg.name);
  assert.equal(body.connections, 1);
  assert.equal(body.license.tier, "free");
});

test("the status index counts the notes actually on disk", async () => {
  const body = await (await fetch(`${server.base}/api/status`)).json();
  assert.equal(body.vaults[0].notes, 2, "the fixture vault has two notes");
  assert.equal(body.vaults[0].error, null);
});

test("GET /api/license summarizes the current plan", async () => {
  const res = await fetch(`${server.base}/api/license`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, "free");
  assert.equal(body.limits.queries_per_month, 50);
});

test("/mcp refuses a request with no API key", async () => {
  const res = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, -32001);
});

test("/mcp refuses a wrong API key", async () => {
  const res = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-not-a-real-key",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
});

test("/mcp lists all 9 tools for a valid key", async () => {
  const res = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${connection.key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);

  // The streamable transport may answer as JSON or as a single SSE frame.
  const raw = await res.text();
  const json = raw.startsWith("event:") || raw.startsWith("data:")
    ? JSON.parse(raw.split("\n").find((l) => l.startsWith("data:")).slice(5))
    : JSON.parse(raw);

  const names = json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create_link",
    "create_note",
    "get_backlinks",
    "get_daily_note",
    "get_tags",
    "list_notes",
    "read_note",
    "search_notes",
    "update_note",
  ]);
});

test("the landing page is served at / with its checkout hook intact", async () => {
  const res = await fetch(`${server.base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  // The pricing buttons POST here; if this drifts, nobody can buy anything.
  assert.match(html, /\/api\/checkout/);
});

test("POST /api/checkout reports the missing Stripe config instead of hanging", async () => {
  const res = await fetch(`${server.base}/api/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "personal" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Stripe is not configured/);
});

test("POST /api/checkout/claim refuses a request with no session ID", async () => {
  const res = await fetch(`${server.base}/api/checkout/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /session ID is required/);
});

test("POST /api/checkout/claim does not mint keys without vendor credentials", async () => {
  const res = await fetch(`${server.base}/api/checkout/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "cs_test_abc123" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Stripe is not configured/);
});
