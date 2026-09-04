import test from "node:test";
import assert from "node:assert/strict";
import { gate, fakeVault, context } from "./helpers.mjs";

const {
  handleMessage,
  handlePayload,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  noteUri,
  parseNoteUri,
} = gate;

const req = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });

test("initialize advertises the server and its capabilities", async () => {
  const { ctx } = context(fakeVault());
  const res = await handleMessage(
    req("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION }),
    ctx,
  );
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(res.result.serverInfo.name, "vault-gate");
  assert.ok(res.result.capabilities.tools);
  assert.ok(res.result.capabilities.resources);
});

test("initialize echoes back an older protocol the client asked for", async () => {
  const { ctx } = context(fakeVault());
  const old = SUPPORTED_PROTOCOL_VERSIONS.at(-1);
  const res = await handleMessage(req("initialize", { protocolVersion: old }), ctx);
  assert.equal(res.result.protocolVersion, old);
});

test("initialize falls back to the latest protocol for an unknown one", async () => {
  const { ctx } = context(fakeVault());
  const res = await handleMessage(req("initialize", { protocolVersion: "1999-01-01" }), ctx);
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

test("notifications get no response", async () => {
  const { ctx } = context(fakeVault());
  assert.equal(
    await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx),
    null,
  );
});

test("tools/list reflects the granted permissions", async () => {
  const { ctx } = context(fakeVault(), ["read"]);
  const res = await handleMessage(req("tools/list"), ctx);
  const names = res.result.tools.map((t) => t.name);
  assert.ok(names.includes("read_note"));
  assert.ok(!names.includes("create_note"));
  for (const tool of res.result.tools) {
    assert.ok(tool.inputSchema, `${tool.name} carries a schema`);
  }
});

test("tools/call runs the tool", async () => {
  const { ctx } = context(fakeVault({ "a.md": "hello" }));
  const res = await handleMessage(
    req("tools/call", { name: "read_note", arguments: { path: "a.md" } }),
    ctx,
  );
  assert.equal(JSON.parse(res.result.content[0].text).body, "hello");
});

test("a failing tool call is a result with isError, not a JSON-RPC error", async () => {
  const { ctx } = context(fakeVault());
  const res = await handleMessage(
    req("tools/call", { name: "read_note", arguments: { path: "gone.md" } }),
    ctx,
  );
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true);
});

test("unknown methods return -32601", async () => {
  const { ctx } = context(fakeVault());
  const res = await handleMessage(req("does/not/exist"), ctx);
  assert.equal(res.error.code, -32601);
});

test("a malformed message is rejected", async () => {
  const { ctx } = context(fakeVault());
  const res = await handleMessage({ jsonrpc: "1.0", id: 4, method: "ping" }, ctx);
  assert.equal(res.error.code, -32600);
});

test("resources/list exposes notes, and resources/read returns one", async () => {
  const { ctx } = context(fakeVault({ "note one.md": "body" }));
  const list = await handleMessage(req("resources/list"), ctx);
  assert.equal(list.result.resources.length, 1);

  const { uri } = list.result.resources[0];
  const read = await handleMessage(req("resources/read", { uri }), ctx);
  assert.equal(read.result.contents[0].text, "body");
  assert.equal(read.result.contents[0].mimeType, "text/markdown");
});

test("resources are hidden without read permission", async () => {
  const { ctx } = context(fakeVault({ "a.md": "x" }), ["search"]);
  const res = await handleMessage(req("resources/list"), ctx);
  assert.deepEqual(res.result.resources, []);
});

test("note URIs round-trip through paths with spaces and slashes", () => {
  const uri = noteUri("My Vault", "sub folder/a note.md");
  assert.equal(parseNoteUri(uri), "sub folder/a note.md");
  assert.equal(parseNoteUri("http://example.com/x"), null);
});

test("ping answers", async () => {
  const { ctx } = context(fakeVault());
  const res = await handleMessage(req("ping"), ctx);
  assert.deepEqual(res.result, {});
});

test("a batch returns one response per request and drops notifications", async () => {
  const { ctx } = context(fakeVault());
  const res = await handlePayload(
    [req("ping", {}, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, req("ping", {}, 2)],
    ctx,
  );
  assert.equal(res.length, 2);
  assert.deepEqual(res.map((r) => r.id), [1, 2]);
});

test("a non-object payload is a parse error", async () => {
  const { ctx } = context(fakeVault());
  const res = await handlePayload("nope", ctx);
  assert.equal(res.error.code, -32700);
});
