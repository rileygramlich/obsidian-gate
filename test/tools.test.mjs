import test from "node:test";
import assert from "node:assert/strict";
import { gate, fakeVault, context } from "./helpers.mjs";

const { callTool, toolsFor, TOOL_DEFINITIONS } = gate;

const parse = (result) => JSON.parse(result.content[0].text);

test("every tool declares a name, description, permission and schema", () => {
  assert.equal(TOOL_DEFINITIONS.length, 9);
  for (const t of TOOL_DEFINITIONS) {
    assert.ok(t.name, "name");
    assert.ok(t.description.length > 20, `${t.name} description`);
    assert.ok(["read", "write", "search"].includes(t.permission), `${t.name} permission`);
    assert.equal(t.inputSchema.type, "object", `${t.name} schema`);
  }
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "names are unique");
});

test("toolsFor hides tools the connection may not call", () => {
  const readOnly = toolsFor(["read"]).map((t) => t.name);
  assert.ok(readOnly.includes("read_note"));
  assert.ok(!readOnly.includes("create_note"));
  assert.ok(!readOnly.includes("search_notes"));
  assert.equal(toolsFor(["read", "write", "search"]).length, 9);
  assert.equal(toolsFor([]).length, 0);
});

test("read_note returns the note", async () => {
  const vault = fakeVault({ "a.md": "hello" });
  const { ctx } = context(vault);
  const out = await callTool("read_note", { path: "a.md" }, ctx);
  assert.ok(!out.isError);
  assert.equal(parse(out).body, "hello");
});

test("a missing note is an error result, not a thrown exception", async () => {
  const { ctx } = context(fakeVault());
  const out = await callTool("read_note", { path: "nope.md" }, ctx);
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /No note at/);
});

test("an unknown tool is rejected", async () => {
  const { ctx } = context(fakeVault());
  const out = await callTool("rm_rf", {}, ctx);
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown tool/);
});

test("write tools are refused without the write permission", async () => {
  const vault = fakeVault();
  const { ctx } = context(vault, ["read", "search"]);
  for (const [name, args] of [
    ["create_note", { path: "x.md", content: "hi" }],
    ["update_note", { path: "x.md", content: "hi" }],
    ["create_link", { from: "a.md", to: "b.md" }],
  ]) {
    const out = await callTool(name, args, ctx);
    assert.equal(out.isError, true, name);
    assert.match(out.content[0].text, /lacks "write" permission/, name);
  }
  assert.equal(vault.store.size, 0, "nothing was written");
});

test("search is refused without the search permission", async () => {
  const { ctx } = context(fakeVault({ "a.md": "hi" }), ["read"]);
  const out = await callTool("search_notes", { query: "hi" }, ctx);
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /lacks "search" permission/);
});

test("create_note writes and reports the new note", async () => {
  const vault = fakeVault();
  const { ctx } = context(vault);
  const out = await callTool("create_note", { path: "new.md", content: "body" }, ctx);
  assert.equal(parse(out).created, true);
  assert.equal(vault.store.get("new.md"), "body");
});

test("update_note append mode goes through appendToNote", async () => {
  const vault = fakeVault({ "a.md": "one" });
  const { ctx } = context(vault);
  await callTool("update_note", { path: "a.md", content: "two", mode: "append" }, ctx);
  assert.equal(vault.store.get("a.md"), "one\ntwo");
  assert.ok(vault.calls.some(([m]) => m === "appendToNote"));
});

test("update_note defaults to overwriting", async () => {
  const vault = fakeVault({ "a.md": "one" });
  const { ctx } = context(vault);
  await callTool("update_note", { path: "a.md", content: "two" }, ctx);
  assert.equal(vault.store.get("a.md"), "two");
});

test("get_daily_note resolves relative dates before hitting the vault", async () => {
  const vault = fakeVault();
  const { ctx } = context(vault);
  const out = await callTool("get_daily_note", { date: "today" }, ctx);
  const body = parse(out);
  assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.created, true);
  assert.deepEqual(vault.calls[0], ["getDailyNote", body.date, true]);
});

test("get_daily_note honours create: false", async () => {
  const { ctx } = context(fakeVault());
  const out = await callTool("get_daily_note", { date: "2026-01-01", create: false }, ctx);
  assert.equal(out.isError, true);
});

test("activity is recorded for successes and failures", async () => {
  const { ctx, activity } = context(fakeVault({ "a.md": "hi" }));
  await callTool("read_note", { path: "a.md" }, ctx);
  await callTool("read_note", { path: "missing.md" }, ctx);
  assert.equal(activity.length, 2);
  assert.equal(activity[0].ok, true);
  assert.equal(activity[1].ok, false);
});
