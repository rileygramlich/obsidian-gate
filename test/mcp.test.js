import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useTempHome, makeVault, rm, PROJECT_NOTES } from "./helpers.js";

const home = useTempHome();
const vaultCfg = makeVault(PROJECT_NOTES);

// Point the server at our throwaway vault before anything reads config.
const { defaultConfig } = await import("../dist/config.js");
const seed = defaultConfig();
seed.vaults = [vaultCfg];
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(seed, null, 2));

const { callTool, TOOL_DEFINITIONS, SERVER_NAME, SERVER_VERSION } = await import("../dist/mcp-server.js");

test.after(() => {
  rm(home);
  rm(vaultCfg.path);
});

const parse = (res) => JSON.parse(res.content[0].text);
const call = (name, args = {}, ctx = {}) => callTool(name, args, ctx);

/* ------------------------- tool declarations ------------------------ */

test("every advertised tool has a name, description and input schema", () => {
  assert.ok(TOOL_DEFINITIONS.length >= 9);
  for (const t of TOOL_DEFINITIONS) {
    assert.ok(t.name, "tool needs a name");
    assert.ok(t.description?.length > 10, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, "object", `${t.name} needs an object schema`);
  }
});

test("tool names are unique", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test("the documented tool set is present", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  for (const expected of [
    "list_notes", "read_note", "search_notes", "create_note",
    "update_note", "get_backlinks", "get_tags", "get_daily_note", "create_link",
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
});

test("server identity is set", () => {
  assert.equal(SERVER_NAME, "obsidian-gate");
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/);
});

/* ---------------------------- dispatch ------------------------------ */

test("an unknown tool fails instead of throwing", async () => {
  const res = await call("no_such_tool");
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown tool/i);
});

test("list_notes returns the vault's top level", async () => {
  const out = parse(await call("list_notes", {}));
  assert.equal(out.count, 2);
});

test("read_note returns frontmatter and body", async () => {
  const out = parse(await call("read_note", { path: "Projects/Alpha.md" }));
  assert.deepEqual(out.frontmatter.tags, ["project", "active"]);
  assert.match(out.body, /# Alpha/);
});

test("search_notes finds a keyword", async () => {
  const out = parse(await call("search_notes", { query: "pineapple" }));
  assert.equal(out.count, 1);
  assert.equal(out.results[0].path, "Projects/Alpha.md");
});

test("get_tags aggregates across the vault", async () => {
  const out = parse(await call("get_tags", {}));
  assert.ok(out.tags.some((t) => t.tag === "project"));
});

test("get_backlinks reports incoming links", async () => {
  const out = parse(await call("get_backlinks", { path: "Projects/Beta.md" }));
  assert.equal(out.count, 2);
});

test("create_note then read_note round-trips through the tool layer", async () => {
  const created = parse(await call("create_note", { path: "Projects/Delta.md", content: "# Delta\n" }));
  assert.equal(created.created, true);
  const read = parse(await call("read_note", { path: "Projects/Delta.md" }));
  assert.match(read.body, /# Delta/);
});

test("update_note replaces the body", async () => {
  await call("create_note", { path: "Projects/Epsilon.md", content: "# One\n" });
  await call("update_note", { path: "Projects/Epsilon.md", content: "# Two\n" });
  assert.match(parse(await call("read_note", { path: "Projects/Epsilon.md" })).body, /# Two/);
});

test("get_daily_note creates today's note", async () => {
  const out = parse(await call("get_daily_note", {}));
  assert.match(out.path, /^01-Daily\/\d{4}-\d{2}-\d{2}\.md$/);
});

/* ------------------------- error surfaces --------------------------- */

test("reading a missing note is a tool error, not a crash", async () => {
  const res = await call("read_note", { path: "Projects/Ghost.md" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not found/i);
});

test("path traversal is refused through the tool layer", async () => {
  for (const bad of ["../../../../etc/passwd", "../escape.md"]) {
    const res = await call("read_note", { path: bad });
    assert.equal(res.isError, true, `${bad} must be refused`);
    assert.match(res.content[0].text, /escapes the vault/i);
  }
});

test("writing outside the vault is refused", async () => {
  const res = await call("create_note", { path: "../escape.md", content: "nope" });
  assert.equal(res.isError, true);
  assert.ok(!fs.existsSync(path.join(path.dirname(vaultCfg.path), "escape.md")));
});

/* ------------------------ permission gating ------------------------- */

const readOnlyConn = {
  key: "sk-readonly", name: "read-only-agent", vault: vaultCfg.name,
  permissions: ["read"], created: new Date().toISOString(), last_used: null,
};

test("a read-only connection may read", async () => {
  const res = await call("read_note", { path: "Projects/Alpha.md" }, { connection: readOnlyConn });
  assert.notEqual(res.isError, true);
});

test("a read-only connection may not write", async () => {
  const res = await call("create_note", { path: "Projects/Blocked.md", content: "x" }, { connection: readOnlyConn });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /permission/i);
  assert.ok(!fs.existsSync(path.join(vaultCfg.path, "Projects/Blocked.md")), "the file must not be created");
});

test("a read-only connection may not search", async () => {
  const res = await call("search_notes", { query: "pineapple" }, { connection: readOnlyConn });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /permission/i);
});
