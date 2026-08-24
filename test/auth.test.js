import test from "node:test";
import assert from "node:assert/strict";
import { useTempHome, rm } from "./helpers.js";

const home = useTempHome();
test.after(() => rm(home));

const {
  ALL_PERMISSIONS, generateKey, createConnection, findConnection, revokeConnection,
  rotateConnection, setPermissions, hasPermission, assertPermission, maskKey, extractKey,
} = await import("../dist/auth.js");
const { defaultConfig } = await import("../dist/config.js");

/* ------------------------------- keys ------------------------------- */

test("generateKey() produces unique, prefixed keys", () => {
  const keys = new Set(Array.from({ length: 200 }, generateKey));
  assert.equal(keys.size, 200, "no collisions across 200 keys");
  for (const k of keys) assert.match(k, /^sk-[0-9a-f]{32,}$/);
});

test("maskKey() hides the middle but keeps both ends", () => {
  const masked = maskKey("sk-1a2b3c4d5e6f7a8b9c0d");
  assert.match(masked, /^sk-1a2b…/);
  assert.ok(!masked.includes("3c4d5e6f"), "the secret middle must not survive masking");
});

test("maskKey() leaves short strings alone", () => {
  assert.equal(maskKey("sk-short"), "sk-short");
});

/* --------------------------- connections ---------------------------- */

test("createConnection() registers a usable connection", () => {
  const cfg = defaultConfig();
  const conn = createConnection(cfg, "agent-one", "main", ALL_PERMISSIONS);
  assert.equal(cfg.agent_connections.length, 1);
  assert.equal(conn.name, "agent-one");
  assert.deepEqual(conn.permissions, ALL_PERMISSIONS);
});

test("findConnection() matches a real key and rejects everything else", () => {
  const cfg = defaultConfig();
  const conn = createConnection(cfg, "agent-one", "main", ALL_PERMISSIONS);
  assert.equal(findConnection(cfg, conn.key)?.name, "agent-one");
  assert.equal(findConnection(cfg, "sk-wrong"), null);
  assert.equal(findConnection(cfg, ""), null);
  assert.equal(findConnection(cfg, null), null);
  assert.equal(findConnection(cfg, undefined), null);
});

test("revokeConnection() removes the key so it stops authenticating", () => {
  const cfg = defaultConfig();
  const conn = createConnection(cfg, "doomed", "main", ALL_PERMISSIONS);
  assert.equal(revokeConnection(cfg, conn.key), true);
  assert.equal(findConnection(cfg, conn.key), null);
  assert.equal(revokeConnection(cfg, conn.key), false, "revoking twice is a no-op");
});

test("rotateConnection() issues a new key and retires the old one", () => {
  const cfg = defaultConfig();
  const conn = createConnection(cfg, "rotate-me", "main", ALL_PERMISSIONS);
  const oldKey = conn.key;
  const rotated = rotateConnection(cfg, oldKey);
  assert.notEqual(rotated.key, oldKey);
  assert.equal(findConnection(cfg, oldKey), null, "the old key must stop working");
  assert.equal(findConnection(cfg, rotated.key)?.name, "rotate-me");
});

/* --------------------------- permissions ---------------------------- */

test("hasPermission() enforces the granted set", () => {
  const cfg = defaultConfig();
  const readOnly = createConnection(cfg, "reader", "main", ["read"]);
  assert.equal(hasPermission(readOnly, "read"), true);
  assert.equal(hasPermission(readOnly, "write"), false);
  assert.equal(hasPermission(readOnly, "search"), false);
});

test("hasPermission() trusts stdio sessions (null connection)", () => {
  for (const p of ALL_PERMISSIONS) assert.equal(hasPermission(null, p), true);
});

test("assertPermission() throws a named, actionable error", () => {
  const cfg = defaultConfig();
  const readOnly = createConnection(cfg, "reader", "main", ["read"]);
  assert.throws(() => assertPermission(readOnly, "write"), /reader.*write/s);
  assert.doesNotThrow(() => assertPermission(readOnly, "read"));
});

test("setPermissions() narrows an existing connection", () => {
  const cfg = defaultConfig();
  const conn = createConnection(cfg, "shrink", "main", ALL_PERMISSIONS);
  setPermissions(cfg, conn.key, ["read"]);
  assert.deepEqual(findConnection(cfg, conn.key).permissions, ["read"]);
});

/* --------------------------- key extraction ------------------------- */

const fakeReq = (headers) => ({
  get: (name) => headers[name.toLowerCase()] ?? undefined,
  headers,
});

test("extractKey() reads a Bearer token case-insensitively", () => {
  assert.equal(extractKey(fakeReq({ authorization: "Bearer sk-abc" })), "sk-abc");
  assert.equal(extractKey(fakeReq({ authorization: "bearer sk-abc" })), "sk-abc");
});

test("extractKey() falls back to the x-api-key header", () => {
  assert.equal(extractKey(fakeReq({ "x-api-key": "sk-xyz" })), "sk-xyz");
});

test("extractKey() returns null when no credential is present", () => {
  assert.equal(extractKey(fakeReq({})), null);
});
