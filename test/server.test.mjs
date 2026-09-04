import test from "node:test";
import assert from "node:assert/strict";
import { gate, fakeVault, context, rpc, connection } from "./helpers.mjs";

const { GateServer } = gate;

/** Boot a server on an ephemeral-ish port and hand it to the test body. */
async function withServer(run, { permissions } = {}) {
  const vault = fakeVault({ "a.md": "hello world" });
  const { ctx } = context(vault, permissions);
  // Port 0 lets the OS pick, but we need to know it: retry a high range instead.
  const port = 24000 + Math.floor(Math.random() * 1000);
  const server = new GateServer({
    port,
    token: connection.token,
    context: () => ctx,
  });
  const status = await server.start();
  assert.equal(status.state, "running", `server started: ${JSON.stringify(status)}`);
  try {
    await run({ server, port, vault, ctx });
  } finally {
    await server.stop();
  }
}

test("a request with the right token gets through", async () => {
  await withServer(async ({ port }) => {
    const res = await rpc(port, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, {});
  });
});

test("a request with no token is rejected", async () => {
  await withServer(async ({ port }) => {
    const res = await rpc(port, { jsonrpc: "2.0", id: 1, method: "ping" }, { token: null });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, -32001);
  });
});

test("a request with the wrong token is rejected", async () => {
  await withServer(async ({ port }) => {
    const res = await rpc(port, { jsonrpc: "2.0", id: 1, method: "ping" }, { token: "gate_wrong" });
    assert.equal(res.status, 401);
  });
});

test("the token is also accepted as x-api-key and as ?key=", async () => {
  await withServer(async ({ port }) => {
    const viaHeader = await rpc(
      port,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { token: null, headers: { "x-api-key": connection.token } },
    );
    assert.equal(viaHeader.status, 200);

    const viaQuery = await fetch(
      `http://127.0.0.1:${port}/mcp?key=${connection.token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      },
    );
    assert.equal(viaQuery.status, 200);
  });
});

test("a foreign Origin is refused before auth is even considered", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.token}`,
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 403);
  });
});

test("a localhost Origin is allowed", async () => {
  await withServer(async ({ port }) => {
    const res = await rpc(
      port,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { Origin: `http://localhost:${port}` } },
    );
    assert.equal(res.status, 200);
  });
});

test("the server binds to loopback only", async () => {
  await withServer(async ({ server, port }) => {
    const addr = server.getStatus();
    assert.equal(addr.state, "running");
    assert.equal(addr.port, port);
    // A second server on the same port must fail rather than silently share it.
    const clash = new GateServer({
      port,
      token: "x",
      context: () => context(fakeVault()).ctx,
    });
    const status = await clash.start();
    assert.equal(status.state, "error");
    assert.match(status.message, /already in use/);
    await clash.stop();
  });
});

test("/health answers without a token", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.server, "vault-gate");
  });
});

test("unknown paths 404 and GET /mcp declines the SSE stream", async () => {
  await withServer(async ({ port }) => {
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);

    const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.equal(stream.status, 405);
  });
});

test("a notification-only POST gets 202 and no body", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
  });
});

test("malformed JSON is a parse error, not a crash", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.token}`,
      },
      body: "{ not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
  });
});

test("a full initialize → list → call handshake works over HTTP", async () => {
  await withServer(async ({ port }) => {
    const init = await rpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(init.body.result.serverInfo.name, "vault-gate");

    const list = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(list.body.result.tools.length, 9);

    const call = await rpc(port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_notes", arguments: { query: "hello" } },
    });
    const payload = JSON.parse(call.body.result.content[0].text);
    assert.equal(payload.count, 1);
  });
});

test("stopping frees the port for an immediate restart", async () => {
  const { ctx } = context(fakeVault());
  const port = 24500 + Math.floor(Math.random() * 400);
  const server = new GateServer({ port, token: "t", context: () => ctx });

  assert.equal((await server.start()).state, "running");
  await server.stop();
  assert.equal(server.getStatus().state, "stopped");
  assert.equal((await server.start()).state, "running", "restarted on the same port");
  await server.stop();
});
