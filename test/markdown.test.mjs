import test from "node:test";
import assert from "node:assert/strict";
import { gate } from "./helpers.mjs";

const {
  parseFrontmatter,
  stringifyFrontmatter,
  renderTemplate,
  extractLinks,
  extractTags,
  normalizeDate,
  normalizeVaultPath,
  snippet,
  occurrences,
} = gate;

test("parseFrontmatter splits frontmatter from body", () => {
  const { frontmatter, body } = parseFrontmatter(
    "---\ntitle: Hello\ncount: 3\ndone: true\ntags:\n  - a\n  - b\n---\n\n# Body\n",
  );
  assert.equal(frontmatter.title, "Hello");
  assert.equal(frontmatter.count, 3);
  assert.equal(frontmatter.done, true);
  assert.deepEqual(frontmatter.tags, ["a", "b"]);
  assert.equal(body.trim(), "# Body");
});

test("parseFrontmatter passes content through when there is none", () => {
  const { frontmatter, body } = parseFrontmatter("just text\n");
  assert.deepEqual(frontmatter, {});
  assert.equal(body, "just text\n");
});

test("parseFrontmatter reads inline arrays", () => {
  const { frontmatter } = parseFrontmatter("---\ntags: [one, two]\n---\nbody");
  assert.deepEqual(frontmatter.tags, ["one", "two"]);
});

test("stringifyFrontmatter round-trips through the parser", () => {
  const data = { title: "A note", tags: ["x", "y"], empty: [] };
  const { frontmatter } = parseFrontmatter(`${stringifyFrontmatter(data)}\n\nbody`);
  assert.deepEqual(frontmatter, data);
});

test("stringifyFrontmatter quotes values that would break YAML", () => {
  const out = stringifyFrontmatter({ title: "a: b" });
  assert.match(out, /title: "a: b"/);
});

test("renderTemplate expands date tokens", () => {
  const now = new Date("2026-03-04T05:06:07.000Z");
  const out = renderTemplate({ created: "{{date}}", at: "on {{time}}", n: 1 }, now);
  assert.equal(out.created, "2026-03-04");
  assert.equal(out.at, "on 05:06:07");
  assert.equal(out.n, 1);
});

test("extractLinks finds wikilinks, aliases, headings and md links", () => {
  const links = extractLinks(
    "see [[One]] and [[two|Two]] and [[three#Section]] and [text](sub/four.md)",
  );
  assert.deepEqual(links, ["One", "two", "three", "sub/four.md"]);
});

test("extractTags reads frontmatter and inline tags but skips headings and code", () => {
  const tags = extractTags(
    ["---", "tags:", "  - alpha", "---", "", "# Not/A/Tag", "body #beta and `#gamma`", "```", "#delta", "```"].join("\n"),
  );
  assert.deepEqual(tags.sort(), ["alpha", "beta"]);
});

test("normalizeDate accepts keywords, offsets and ISO dates", () => {
  assert.match(normalizeDate("today"), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(normalizeDate("2026-02-01"), "2026-02-01");
  const today = new Date(normalizeDate("today"));
  const yesterday = new Date(normalizeDate("yesterday"));
  assert.equal(Math.round((today - yesterday) / 86400000), 1);
  assert.equal(normalizeDate("-1"), normalizeDate("yesterday"));
});

test("normalizeDate rejects nonsense", () => {
  assert.throws(() => normalizeDate("not a date"), /Unrecognized date/);
});

test("normalizeVaultPath adds .md and strips leading slashes", () => {
  assert.equal(normalizeVaultPath("/notes/idea"), "notes/idea.md");
  assert.equal(normalizeVaultPath("notes/idea.md"), "notes/idea.md");
  assert.equal(normalizeVaultPath("board.canvas"), "board.canvas");
});

test("normalizeVaultPath refuses to escape the vault", () => {
  assert.throws(() => normalizeVaultPath("../secrets.md"), /escapes the vault/);
  assert.throws(() => normalizeVaultPath("a/../../b.md"), /escapes the vault/);
  assert.throws(() => normalizeVaultPath(".obsidian/plugins/x.md"), /off limits/);
  assert.throws(() => normalizeVaultPath(""), /required/);
});

test("snippet centres long lines on the search term", () => {
  const line = `${"a".repeat(300)}needle${"b".repeat(300)}`;
  const out = snippet(line, ["needle"]);
  assert.ok(out.includes("needle"));
  assert.ok(out.length < line.length);
});

test("occurrences counts non-overlapping hits", () => {
  assert.equal(occurrences("abcabcabc", "abc"), 3);
  assert.equal(occurrences("aaa", ""), 0);
});
