import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useTempHome, makeVault } from "./helpers.js";

useTempHome();
const { Vault, VaultError, parseFrontmatter, stringifyFrontmatter, extractLinks, extractTags, normalizeDate } =
  await import("../dist/vault.js");

const vault = () => new Vault(makeVault());

/* ------------------------------ safety ------------------------------ */

test("resolve() refuses paths that escape the vault", () => {
  const v = vault();
  for (const bad of ["../outside.md", "../../etc/passwd", "Projects/../../escape.md"]) {
    assert.throws(() => v.resolve(bad), VaultError, `should reject ${bad}`);
  }
});

test("resolve() strips leading slashes instead of going absolute", () => {
  const v = vault();
  assert.equal(v.resolve("/Projects/Alpha.md"), path.join(v.root, "Projects/Alpha.md"));
});

test("resolve() allows ordinary nested paths", () => {
  const v = vault();
  assert.equal(v.resolve("Projects/Alpha.md"), path.join(v.root, "Projects/Alpha.md"));
});

test("assertExists() throws for a missing vault directory", () => {
  const v = new Vault({ name: "ghost", path: "/nonexistent/vault/xyz", daily_notes_path: "", frontmatter_template: {} });
  assert.throws(() => v.assertExists(), VaultError);
});

/* ------------------------------ reading ----------------------------- */

test("readNote() returns frontmatter and body separately", async () => {
  const note = await vault().readNote("Projects/Alpha.md");
  assert.deepEqual(note.frontmatter.tags, ["project", "active"]);
  assert.match(note.body, /# Alpha/);
  assert.doesNotMatch(note.body, /^---/, "body must not include the frontmatter block");
});

test("readNote() appends .md when the extension is omitted", async () => {
  const note = await vault().readNote("Projects/Alpha");
  assert.equal(note.path, "Projects/Alpha.md");
});

test("readNote() throws a clear error for a missing note", async () => {
  await assert.rejects(() => vault().readNote("Projects/Nope.md"), /not found/i);
});

test("listNotes() lists folders and notes at the root", async () => {
  const entries = await vault().listNotes("");
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, ["Daily", "Projects"]);
  assert.ok(entries.every((e) => e.type === "folder"));
});

test("allNotes() finds every markdown file recursively", async () => {
  const all = await vault().allNotes();
  assert.equal(all.length, 3);
  assert.ok(all.includes("Projects/Alpha.md"));
});

/* ------------------------------ search ------------------------------ */

test("searchNotes() finds body matches and reports line numbers", async () => {
  const hits = await vault().searchNotes("pineapple");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "Projects/Alpha.md");
  assert.ok(hits[0].matches[0].line > 0);
});

test("searchNotes() returns nothing for an absent term", async () => {
  assert.deepEqual(await vault().searchNotes("zzzznotpresent"), []);
});

test("searchNotes() is case-insensitive", async () => {
  const hits = await vault().searchNotes("PINEAPPLE");
  assert.equal(hits.length, 1);
});

test("searchNotes() honours the limit argument", async () => {
  const hits = await vault().searchNotes("e", 2);
  assert.ok(hits.length <= 2);
});

/* ------------------------------ writing ----------------------------- */

test("createNote() writes the file and applies the frontmatter template", async () => {
  const v = vault();
  const note = await v.createNote("Projects/Gamma.md", "# Gamma\n");
  assert.equal(note.path, "Projects/Gamma.md");
  assert.ok(fs.existsSync(v.resolve("Projects/Gamma.md")));
  assert.ok(note.frontmatter.created, "template should stamp a created date");
});

test("createNote() refuses to clobber an existing note", async () => {
  await assert.rejects(() => vault().createNote("Projects/Alpha.md", "x"), /already exists/i);
});

test("createNote() rejects a path outside the vault", async () => {
  await assert.rejects(() => vault().createNote("../escape.md", "x"), VaultError);
});

test("updateNote() replaces content in place", async () => {
  const v = vault();
  await v.updateNote("Projects/Beta.md", "# Beta\n\nRewritten.\n");
  const note = await v.readNote("Projects/Beta.md");
  assert.match(note.body, /Rewritten/);
});

test("appendToNote() preserves what was already there", async () => {
  const v = vault();
  await v.appendToNote("Projects/Beta.md", "Appended line.");
  const note = await v.readNote("Projects/Beta.md");
  assert.match(note.body, /No links here/);
  assert.match(note.body, /Appended line/);
});

/* --------------------------- links and tags ------------------------- */

test("getBacklinks() finds every note pointing at the target", async () => {
  const links = await vault().getBacklinks("Projects/Beta.md");
  const sources = links.map((l) => l.path).sort();
  assert.deepEqual(sources, ["Daily/2026-01-02.md", "Projects/Alpha.md"]);
});

test("getBacklinks() returns an empty list when nothing links in", async () => {
  assert.deepEqual(await vault().getBacklinks("Projects/Alpha.md"), []);
});

test("getTags() aggregates frontmatter and inline tags", async () => {
  const tags = await vault().getTags();
  const names = tags.map((t) => t.tag);
  assert.ok(names.includes("project"));
  assert.ok(names.includes("active"));
  assert.ok(names.includes("standalone"), "inline #tags should be counted too");
});

test("createLink() adds a wikilink and is idempotent", async () => {
  const v = vault();
  const first = await v.createLink("Projects/Beta.md", "Projects/Alpha.md");
  assert.equal(first.alreadyLinked, false);
  assert.match((await v.readNote("Projects/Beta.md")).body, /\[\[Alpha\]\]/);

  const second = await v.createLink("Projects/Beta.md", "Projects/Alpha.md");
  assert.equal(second.alreadyLinked, true, "linking twice must not duplicate");
});

/* ---------------------------- daily notes --------------------------- */

test("getDailyNote() creates the note under the configured folder", async () => {
  const v = vault();
  const { note, created } = await v.getDailyNote("2026-03-04");
  assert.equal(created, true);
  assert.equal(note.path, "Daily/2026-03-04.md");
  assert.deepEqual(note.frontmatter.tags, ["daily"]);
});

test("getDailyNote() returns the existing note on a second call", async () => {
  const v = vault();
  await v.getDailyNote("2026-03-05");
  assert.equal((await v.getDailyNote("2026-03-05")).created, false);
});

/* ----------------------------- pure helpers ------------------------- */

test("parseFrontmatter() splits YAML from body", () => {
  const { frontmatter, body } = parseFrontmatter("---\ntags: [a, b]\ntitle: Hi\n---\n# Body\n");
  assert.deepEqual(frontmatter.tags, ["a", "b"]);
  assert.equal(frontmatter.title, "Hi");
  assert.equal(body.trim(), "# Body");
});

test("parseFrontmatter() handles content with no frontmatter", () => {
  const { frontmatter, body } = parseFrontmatter("# Just a heading\n");
  assert.deepEqual(frontmatter, {});
  assert.equal(body.trim(), "# Just a heading");
});

test("stringifyFrontmatter() round-trips through parseFrontmatter()", () => {
  const original = { title: "Round Trip", tags: ["x", "y"] };
  const { frontmatter } = parseFrontmatter(stringifyFrontmatter(original) + "body\n");
  assert.equal(frontmatter.title, "Round Trip");
  assert.deepEqual(frontmatter.tags, ["x", "y"]);
});

test("extractLinks() pulls wikilinks and ignores aliases after the pipe", () => {
  const links = extractLinks("See [[Alpha]] and [[Beta|the second]] but not plain text.");
  assert.deepEqual(links.sort(), ["Alpha", "Beta"]);
});

test("extractTags() finds inline hashtags", () => {
  assert.ok(extractTags("Tagged #alpha and #beta-two here.").includes("alpha"));
});

test("normalizeDate() defaults to today and passes through ISO dates", () => {
  assert.match(normalizeDate(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(normalizeDate("2026-07-09"), "2026-07-09");
});
