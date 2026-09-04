/**
 * Shared test setup: a fake vault, and a temp HOME so nothing in the suite can
 * read — or clobber — the developer's real assistant config files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const gate = await import("./.build/gate.mjs");

/**
 * An in-memory stand-in for GateVault. Only the methods the tool dispatcher
 * calls need to exist; the real one is exercised inside Obsidian.
 */
export function fakeVault(notes = {}) {
  const store = new Map(Object.entries(notes));
  const calls = [];

  const note = (p) => ({
    path: p,
    name: p.split("/").pop().replace(/\.md$/, ""),
    frontmatter: {},
    body: store.get(p) ?? "",
    content: store.get(p) ?? "",
    modified: "2026-01-01T00:00:00.000Z",
    size: (store.get(p) ?? "").length,
  });

  const missing = (p) => {
    const err = new Error(`No note at "${p}".`);
    err.name = "GateError";
    throw err;
  };

  return {
    calls,
    store,
    name: "Test Vault",
    async listNotes(p = "") {
      calls.push(["listNotes", p]);
      return [...store.keys()]
        .filter((k) => (p ? k.startsWith(`${p}/`) : !k.includes("/")))
        .map((k) => ({ name: k, path: k, type: "note" }));
    },
    async allNotes() {
      calls.push(["allNotes"]);
      return [...store.keys()].sort();
    },
    async readNote(p) {
      calls.push(["readNote", p]);
      if (!store.has(p)) missing(p);
      return note(p);
    },
    async searchNotes(q, limit) {
      calls.push(["searchNotes", q, limit]);
      return [...store.entries()]
        .filter(([, body]) => body.toLowerCase().includes(q.toLowerCase()))
        .slice(0, limit ?? 50)
        .map(([p]) => ({ path: p, name: p, score: 1, matches: [] }));
    },
    async createNote(p, content) {
      calls.push(["createNote", p]);
      if (store.has(p)) throw new Error(`"${p}" already exists.`);
      store.set(p, content);
      return note(p);
    },
    async updateNote(p, content) {
      calls.push(["updateNote", p]);
      if (!store.has(p)) missing(p);
      store.set(p, content);
      return note(p);
    },
    async appendToNote(p, text) {
      calls.push(["appendToNote", p]);
      if (!store.has(p)) missing(p);
      store.set(p, `${store.get(p)}\n${text}`);
      return note(p);
    },
    async getBacklinks(p) {
      calls.push(["getBacklinks", p]);
      return [];
    },
    async getTags() {
      calls.push(["getTags"]);
      return [{ tag: "test", count: 1, notes: [...store.keys()].slice(0, 1) }];
    },
    async getDailyNote(date, create) {
      calls.push(["getDailyNote", date, create]);
      const p = `${date}.md`;
      if (!store.has(p)) {
        if (!create) missing(p);
        store.set(p, `# ${date}\n`);
        return { note: note(p), created: true };
      }
      return { note: note(p), created: false };
    },
    async createLink(from, to) {
      calls.push(["createLink", from, to]);
      return { from, to, alreadyLinked: false, link: `[[${to}]]` };
    },
    async stats() {
      return { notes: store.size, folders: 0, bytes: 0 };
    },
  };
}

export function context(vault, permissions = ["read", "write", "search"]) {
  const activity = [];
  return {
    ctx: { vault, permissions, onActivity: (e) => activity.push(e) },
    activity,
  };
}

/** A throwaway directory that stands in for $HOME during a test. */
export function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-gate-test-"));
  const prevHome = process.env.HOME;
  const prevAppData = process.env.APPDATA;
  process.env.HOME = dir;
  process.env.APPDATA = path.join(dir, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config");

  return {
    dir,
    restore() {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const connection = {
  serverName: "obsidian",
  url: "http://127.0.0.1:22360/mcp",
  token: "gate_testtoken",
};

/** Post one JSON-RPC message to a running GateServer. */
export async function rpc(port, body, { token = connection.token, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
