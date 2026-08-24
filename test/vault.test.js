/** Vault path resolution — the boundary that keeps an agent inside the vault. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { useTempHome, makeVault, rm, PROJECT_NOTES } from "./helpers.js";

const home = useTempHome();
const vaultCfg = makeVault();

const {
  Vault, VaultError, normalizeDate, parseFrontmatter, stringifyFrontmatter,
  extractLinks, extractTags,
} = await import("../dist/vault.js");

const vault = new Vault(vaultCfg);

/**
 * The tests below mutate the vault, so each gets its own copy of the richer
 * PROJECT_NOTES fixture rather than sharing the module-level one.
 */
const scratchVaults = [];
function freshVault() {
  const cfg = makeVault(PROJECT_NOTES);
  scratchVaults.push(cfg.path);
  return new Vault(cfg);
}

test.after(() => {
  rm(home);
  rm(vaultCfg.path);
  for (const dir of scratchVaults) rm(dir);
});

test("resolve keeps ordinary relative paths inside the vault", () => {
  const abs = vault.resolve("notes/alpha.md");
  assert.equal(abs, path.join(vault.root, "notes", "alpha.md"));
  assert.ok(abs.startsWith(vault.root));
});

test("resolve refuses to escape the vault", () => {
  const escapes = [
    "../outside.md",
    "../../etc/passwd",
    "notes/../../outside.md",
    "notes/../../../etc/shadow",
    "a/b/c/../../../../outside.md",
  ];
  for (const p of escapes) {
    assert.throws(() => vault.resolve(p), VaultError, `"${p}" must be rejected`);
    assert.throws(() => vault.resolve(p), /escapes the vault/);
  }
});

test("resolve strips leading slashes rather than jumping to the filesystem root", () => {
  // "/etc/passwd" must become "<vault>/etc/passwd", never the real /etc/passwd.
  const abs = vault.resolve("/etc/passwd");
  assert.equal(abs, path.join(vault.root, "etc", "passwd"));
  assert.ok(abs.startsWith(vault.root));
});

test("resolve tolerates traversal that stays within the vault", () => {
  assert.equal(vault.resolve("notes/../notes/alpha.md"), path.join(vault.root, "notes", "alpha.md"));
});

test("resolve handles empty and dot paths as the vault root", () => {
  assert.equal(vault.resolve(""), vault.root);
  assert.equal(vault.resolve("."), vault.root);
});

test("toRelative round-trips with forward slashes", () => {
  const abs = vault.resolve("notes/alpha.md");
  assert.equal(vault.toRelative(abs), "notes/alpha.md");
});

test("assertExists rejects a vault path that isn't there", () => {
  const missing = new Vault({ ...vaultCfg, path: "/definitely/not/a/vault" });
  assert.throws(() => missing.assertExists(), /does not exist/);
  assert.doesNotThrow(() => vault.assertExists());
});

test("dailyNotePath places the note in the configured folder", () => {
  assert.equal(vault.dailyNotePath("2026-03-14"), "01-Daily/2026-03-14.md");

  const flat = new Vault({ ...vaultCfg, daily_notes_path: "" });
  assert.equal(flat.dailyNotePath("2026-03-14"), "2026-03-14.md");

  // A folder written with stray slashes still yields one clean path.
  const messy = new Vault({ ...vaultCfg, daily_notes_path: "/Journal/" });
  assert.equal(messy.dailyNotePath("2026-03-14"), "Journal/2026-03-14.md");
});

test("daily note paths stay inside the vault", () => {
  assert.doesNotThrow(() => vault.resolve(vault.dailyNotePath("2026-03-14")));
});

test("normalizeDate understands ISO dates, keywords and offsets", () => {
  assert.equal(normalizeDate("2026-03-14"), "2026-03-14");
  assert.match(normalizeDate(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(normalizeDate("today"), normalizeDate());
  assert.equal(normalizeDate("TODAY"), normalizeDate());
  assert.notEqual(normalizeDate("yesterday"), normalizeDate("today"));
  assert.equal(normalizeDate("-1"), normalizeDate("yesterday"));
  assert.equal(normalizeDate("+1"), normalizeDate("tomorrow"));
});

test("normalizeDate rejects gibberish with a usable message", () => {
  assert.throws(() => normalizeDate("last thursday-ish"), /Unrecognized date/);
});

test("parseFrontmatter splits YAML from body", () => {
  const { frontmatter, body } = parseFrontmatter("---\ntags: [project]\n---\n\n# Alpha\n");
  assert.deepEqual(frontmatter.tags, ["project"]);
  assert.match(body, /# Alpha/);
  assert.ok(!body.includes("---"));
});

test("parseFrontmatter leaves a plain note untouched", () => {
  const { frontmatter, body } = parseFrontmatter("# Beta\n\nno frontmatter here\n");
  assert.deepEqual(frontmatter, {});
  assert.match(body, /# Beta/);
});

test("extractLinks finds wikilinks", () => {
  const links = extractLinks("See [[beta]] and [[notes/gamma|Gamma]].");
  assert.ok(links.includes("beta"));
  assert.equal(links.length, 2);
});

test("extractTags finds inline tags", () => {
  const tags = extractTags("#idea and #project/sub are tags");
  assert.ok(tags.includes("idea"));
});

/* ------------------------------------------------------------------ */
/* Reading, writing and link/tag extraction against a richer fixture.  */
/* ------------------------------------------------------------------ */

test("readNote returns frontmatter and body separately", async () => {
  const note = await freshVault().readNote("Projects/Alpha.md");
  assert.deepEqual(note.frontmatter.tags, ["project", "active"]);
  assert.match(note.body, /# Alpha/);
  assert.doesNotMatch(note.body, /^---/, "body must not include the frontmatter block");
});

test("readNote appends .md when the extension is omitted", async () => {
  assert.equal((await freshVault().readNote("Projects/Alpha")).path, "Projects/Alpha.md");
});

test("readNote throws a clear error for a missing note", async () => {
  await assert.rejects(() => freshVault().readNote("Projects/Nope.md"), /not found/i);
});

test("listNotes lists the folders at the vault root", async () => {
  const entries = await freshVault().listNotes("");
  assert.deepEqual(entries.map((e) => e.name).sort(), ["01-Daily", "Projects"]);
});

test("allNotes finds every markdown file recursively", async () => {
  const all = await freshVault().allNotes();
  assert.equal(all.length, 3);
  assert.ok(all.includes("Projects/Alpha.md"));
});

test("searchNotes finds body matches and reports line numbers", async () => {
  const hits = await freshVault().searchNotes("pineapple");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "Projects/Alpha.md");
  assert.ok(hits[0].matches[0].line > 0);
});

test("searchNotes is case-insensitive and returns nothing for an absent term", async () => {
  const v = freshVault();
  assert.equal((await v.searchNotes("PINEAPPLE")).length, 1);
  assert.deepEqual(await v.searchNotes("zzzznotpresent"), []);
});

test("searchNotes honours the limit argument", async () => {
  assert.ok((await freshVault().searchNotes("e", 2)).length <= 2);
});

test("createNote writes the file and applies the frontmatter template", async () => {
  const v = freshVault();
  const note = await v.createNote("Projects/Gamma.md", "# Gamma\n");
  assert.equal(note.path, "Projects/Gamma.md");
  assert.ok(note.frontmatter.created, "template should stamp a created date");
  assert.doesNotThrow(() => v.resolve("Projects/Gamma.md"));
});

test("createNote refuses to clobber an existing note", async () => {
  await assert.rejects(() => freshVault().createNote("Projects/Alpha.md", "x"), /already exists/i);
});

test("createNote rejects a path outside the vault", async () => {
  await assert.rejects(() => freshVault().createNote("../escape.md", "x"), VaultError);
});

test("updateNote replaces content in place", async () => {
  const v = freshVault();
  await v.updateNote("Projects/Beta.md", "# Beta\n\nRewritten.\n");
  assert.match((await v.readNote("Projects/Beta.md")).body, /Rewritten/);
});

test("appendToNote preserves what was already there", async () => {
  const v = freshVault();
  await v.appendToNote("Projects/Beta.md", "Appended line.");
  const note = await v.readNote("Projects/Beta.md");
  assert.match(note.body, /No links here/);
  assert.match(note.body, /Appended line/);
});

test("getBacklinks finds every note pointing at the target", async () => {
  const links = await freshVault().getBacklinks("Projects/Beta.md");
  assert.deepEqual(links.map((l) => l.path).sort(), ["01-Daily/2026-01-02.md", "Projects/Alpha.md"]);
});

test("getBacklinks returns an empty list when nothing links in", async () => {
  assert.deepEqual(await freshVault().getBacklinks("Projects/Alpha.md"), []);
});

test("getTags aggregates frontmatter and inline tags", async () => {
  const names = (await freshVault().getTags()).map((t) => t.tag);
  assert.ok(names.includes("project"));
  assert.ok(names.includes("active"));
  assert.ok(names.includes("standalone"), "inline #tags should be counted too");
});

test("createLink adds a wikilink and is idempotent", async () => {
  const v = freshVault();
  assert.equal((await v.createLink("Projects/Beta.md", "Projects/Alpha.md")).alreadyLinked, false);
  assert.match((await v.readNote("Projects/Beta.md")).body, /\[\[Alpha\]\]/);
  assert.equal(
    (await v.createLink("Projects/Beta.md", "Projects/Alpha.md")).alreadyLinked,
    true,
    "linking twice must not duplicate",
  );
});

test("getDailyNote creates the note under the configured folder, then reuses it", async () => {
  const v = freshVault();
  const first = await v.getDailyNote("2026-03-04");
  assert.equal(first.created, true);
  assert.equal(first.note.path, "01-Daily/2026-03-04.md");
  assert.deepEqual(first.note.frontmatter.tags, ["daily"]);
  assert.equal((await v.getDailyNote("2026-03-04")).created, false);
});

test("stringifyFrontmatter round-trips through parseFrontmatter", () => {
  const { frontmatter } = parseFrontmatter(
    stringifyFrontmatter({ title: "Round Trip", tags: ["x", "y"] }) + "body\n",
  );
  assert.equal(frontmatter.title, "Round Trip");
  assert.deepEqual(frontmatter.tags, ["x", "y"]);
});

test("extractLinks ignores the alias after a pipe", () => {
  assert.deepEqual(extractLinks("See [[Alpha]] and [[Beta|the second]].").sort(), ["Alpha", "Beta"]);
});
