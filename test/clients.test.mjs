import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gate, tempHome, connection } from "./helpers.mjs";

const { CLIENTS, connectClient, disconnectClient, detectClients, serverEntry, manualSnippet } = gate;

const claudeCode = CLIENTS.find((c) => c.id === "claude-code");
const vscode = CLIENTS.find((c) => c.id === "vscode");

/**
 * Run a test body against a throwaway HOME.
 *
 * These tests write real MCP config files, so the isolation is asserted rather
 * than assumed — a broken tempHome would otherwise silently rewrite the
 * developer's own ~/.claude.json.
 */
async function withHome(run) {
  const home = tempHome();
  try {
    for (const client of CLIENTS) {
      const target = client.configPath();
      assert.ok(
        target.startsWith(home.dir),
        `${client.name} config ${target} must live under the temp home ${home.dir}`,
      );
    }
    await run(home);
  } finally {
    home.restore();
  }
}

test("the server entry is a valid streamable-HTTP MCP config", () => {
  const entry = serverEntry(connection);
  assert.equal(entry.type, "http");
  assert.equal(entry.url, connection.url);
  assert.equal(entry.headers.Authorization, `Bearer ${connection.token}`);
});

test("the manual snippet is parseable JSON under mcpServers", () => {
  const parsed = JSON.parse(manualSnippet(connection));
  assert.ok(parsed.mcpServers.obsidian);
  assert.equal(parsed.mcpServers.obsidian.url, connection.url);
});

test("connecting creates the config file when there is none", async () => {
  await withHome(async () => {
    const res = connectClient(claudeCode, connection);
    assert.equal(res.ok, true, res.message);
    const written = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.equal(written.mcpServers.obsidian.url, connection.url);
  });
});

test("connecting preserves everything else in the file", async () => {
  await withHome(async () => {
    const target = claudeCode.configPath();
    fs.writeFileSync(
      target,
      JSON.stringify({
        theme: "dark",
        mcpServers: { other: { command: "node", args: ["x.js"] } },
      }),
    );

    connectClient(claudeCode, connection);
    const written = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(written.theme, "dark", "unrelated keys survive");
    assert.deepEqual(written.mcpServers.other, { command: "node", args: ["x.js"] });
    assert.ok(written.mcpServers.obsidian, "ours was added");
  });
});

test("connecting backs up the previous config", async () => {
  await withHome(async () => {
    const target = claudeCode.configPath();
    fs.writeFileSync(target, JSON.stringify({ theme: "dark" }));
    connectClient(claudeCode, connection);
    const backup = JSON.parse(fs.readFileSync(`${target}.gate-backup`, "utf8"));
    assert.deepEqual(backup, { theme: "dark" });
  });
});

test("connecting twice is idempotent and refreshes the token", async () => {
  await withHome(async () => {
    connectClient(claudeCode, connection);
    const rotated = { ...connection, token: "gate_rotated" };
    const res = connectClient(claudeCode, rotated);

    const written = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.equal(Object.keys(written.mcpServers).length, 1);
    assert.equal(written.mcpServers.obsidian.headers.Authorization, "Bearer gate_rotated");
  });
});

test("VS Code entries go under `servers`, not `mcpServers`", async () => {
  await withHome(async () => {
    const res = connectClient(vscode, connection);
    assert.equal(res.ok, true, res.message);
    const written = JSON.parse(fs.readFileSync(res.path, "utf8"));
    assert.ok(written.servers.obsidian, "wrote under servers");
    assert.equal(written.mcpServers, undefined);
  });
});

test("a config file with comments and trailing commas is still readable", async () => {
  await withHome(async () => {
    const target = vscode.configPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      ['// my servers', '{', '  "servers": {', '    "keep": { "url": "http://x" },', '  },', '}'].join("\n"),
    );

    const res = connectClient(vscode, connection);
    assert.equal(res.ok, true, res.message);
    const written = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.ok(written.servers.keep, "the existing server survived");
    assert.ok(written.servers.obsidian);
  });
});

test("a URL inside a string is not mistaken for a comment", async () => {
  await withHome(async () => {
    const target = claudeCode.configPath();
    fs.writeFileSync(target, JSON.stringify({ note: "see http://example.com/x for docs" }));
    connectClient(claudeCode, connection);
    const written = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(written.note, "see http://example.com/x for docs");
  });
});

test("a corrupt config is reported rather than overwritten", async () => {
  await withHome(async () => {
    const target = claudeCode.configPath();
    fs.writeFileSync(target, "this is not json at all {{{");
    const res = connectClient(claudeCode, connection);
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(target, "utf8"), "this is not json at all {{{");
  });
});

test("detect reports connected once we have written the entry", async () => {
  await withHome(async () => {
    const before = detectClients(connection).find((s) => s.definition.id === "claude-code");
    assert.equal(before.connected, false);

    connectClient(claudeCode, connection);
    const after = detectClients(connection).find((s) => s.definition.id === "claude-code");
    assert.equal(after.connected, true);
    assert.equal(after.installed, true);
  });
});

test("detect does not claim a client is connected when the URL moved", async () => {
  await withHome(async () => {
    connectClient(claudeCode, connection);
    const onNewPort = { ...connection, url: "http://127.0.0.1:9999/mcp" };
    const state = detectClients(onNewPort).find((s) => s.definition.id === "claude-code");
    assert.equal(state.connected, false, "a stale entry is not a connection");
  });
});

test("disconnecting removes only our entry", async () => {
  await withHome(async () => {
    const target = claudeCode.configPath();
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { other: { url: "http://y" } } }));
    connectClient(claudeCode, connection);
    disconnectClient(claudeCode, connection);

    const written = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(written.mcpServers.obsidian, undefined);
    assert.ok(written.mcpServers.other, "the other server is untouched");
  });
});

test("disconnecting a client that was never configured is a no-op", async () => {
  await withHome(async () => {
    const res = disconnectClient(claudeCode, connection);
    assert.equal(res.ok, true);
  });
});

test("every client definition resolves a path on this platform", () => {
  for (const client of CLIENTS) {
    assert.ok(client.configPath(), `${client.name} has a config path`);
    assert.ok(["mcpServers", "servers"].includes(client.serversKey), client.name);
  }
});
