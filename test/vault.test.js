/** Vault path resolution — the boundary that keeps an agent inside the vault. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { useTempHome, makeVault, rm } from "./helpers.js";

const home = useTempHome();
const vaultCfg = makeVault();

const { Vault, VaultError, normalizeDate, parseFrontmatter, extractLinks, extractTags } =
  await import("../dist/vault.js");

const vault = new Vault(vaultCfg);

test.after(() => {
  rm(home);
  rm(vaultCfg.path);
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
