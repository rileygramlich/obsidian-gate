/**
 * Filesystem operations against an Obsidian vault.
 *
 * Direct filesystem access only — no index, no database, no sync. Obsidian
 * itself owns the files; we just read and write markdown like a careful human
 * would. Last write wins.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { VaultConfig } from "./config.js";

const IGNORED_DIRS = new Set([
  ".obsidian",
  ".trash",
  ".git",
  "node_modules",
  ".DS_Store",
]);

export interface NoteEntry {
  path: string;
  name: string;
  type: "note" | "folder";
  size?: number;
  modified?: string;
}

export interface Note {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  content: string;
  size: number;
  modified: string;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  matches: { line: number; text: string }[];
}

export interface Backlink {
  path: string;
  title: string;
  context: string[];
}

export class VaultError extends Error {}

export class Vault {
  readonly name: string;
  readonly root: string;
  readonly dailyNotesPath: string;
  readonly frontmatterTemplate: Record<string, unknown>;

  constructor(cfg: VaultConfig) {
    this.name = cfg.name;
    this.root = path.resolve(cfg.path);
    this.dailyNotesPath = cfg.daily_notes_path || "";
    this.frontmatterTemplate = cfg.frontmatter_template || {};
  }

  /** Throws unless the vault directory actually exists on disk. */
  assertExists(): void {
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      throw new VaultError(`Vault path does not exist: ${this.root}`);
    }
  }

  /** Resolve a vault-relative path, refusing anything that escapes the vault. */
  resolve(relPath: string): string {
    const clean = (relPath || "").replace(/^[/\\]+/, "");
    const abs = path.resolve(this.root, clean);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new VaultError(`Path escapes the vault: ${relPath}`);
    }
    return abs;
  }

  toRelative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  private withExtension(relPath: string): string {
    return /\.(md|markdown|canvas)$/i.test(relPath) ? relPath : `${relPath}.md`;
  }

  /* ---------------------------------------------------------------- */
  /* list_notes                                                       */
  /* ---------------------------------------------------------------- */

  async listNotes(relPath = ""): Promise<NoteEntry[]> {
    this.assertExists();
    const dir = this.resolve(relPath);
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      throw new VaultError(`Folder not found: ${relPath || "/"}`);
    }

    const out: NoteEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = this.toRelative(abs);
      if (entry.isDirectory()) {
        out.push({ path: rel, name: entry.name, type: "folder" });
      } else if (/\.(md|markdown)$/i.test(entry.name)) {
        const stat = await fsp.stat(abs);
        out.push({
          path: rel,
          name: entry.name.replace(/\.(md|markdown)$/i, ""),
          type: "note",
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    }
    out.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "folder"
          ? -1
          : 1,
    );
    return out;
  }

  /** Every markdown file in the vault, as vault-relative paths. */
  async allNotes(): Promise<string[]> {
    this.assertExists();
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (/\.(md|markdown)$/i.test(entry.name)) out.push(this.toRelative(abs));
      }
    };
    await walk(this.root);
    out.sort();
    return out;
  }

  async countNotes(): Promise<number> {
    return (await this.allNotes()).length;
  }

  /* ---------------------------------------------------------------- */
  /* read_note                                                        */
  /* ---------------------------------------------------------------- */

  async readNote(relPath: string): Promise<Note> {
    this.assertExists();
    const rel = this.withExtension(relPath);
    const abs = this.resolve(rel);
    let content: string;
    try {
      content = await fsp.readFile(abs, "utf8");
    } catch {
      throw new VaultError(`Note not found: ${rel}`);
    }
    const stat = await fsp.stat(abs);
    const { frontmatter, body } = parseFrontmatter(content);
    return {
      path: this.toRelative(abs),
      title: path.basename(abs).replace(/\.(md|markdown)$/i, ""),
      frontmatter,
      body,
      content,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* search_notes                                                     */
  /* ---------------------------------------------------------------- */

  async searchNotes(query: string, limit = 50): Promise<SearchHit[]> {
    this.assertExists();
    const q = query.trim();
    if (!q) throw new VaultError("Search query cannot be empty.");
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const files = await this.allNotes();
    const hits: SearchHit[] = [];

    for (const rel of files) {
      let content: string;
      try {
        content = await fsp.readFile(this.resolve(rel), "utf8");
      } catch {
        continue;
      }
      const haystack = content.toLowerCase();
      const title = path.basename(rel).replace(/\.(md|markdown)$/i, "");
      const titleLower = title.toLowerCase();
      if (!terms.every((t) => haystack.includes(t) || titleLower.includes(t))) {
        continue;
      }

      const matches: SearchHit["matches"] = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < 5; i++) {
        const lower = lines[i].toLowerCase();
        if (terms.some((t) => lower.includes(t))) {
          matches.push({ line: i + 1, text: snippet(lines[i], terms) });
        }
      }

      let score = matches.length;
      for (const t of terms) {
        if (titleLower.includes(t)) score += 10;
        score += occurrences(haystack, t) * 0.25;
      }
      hits.push({ path: rel, title, score: Math.round(score * 100) / 100, matches });
    }

    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return hits.slice(0, limit);
  }

  /* ---------------------------------------------------------------- */
  /* create_note / update_note                                        */
  /* ---------------------------------------------------------------- */

  async createNote(
    relPath: string,
    content: string,
    opts: { overwrite?: boolean; frontmatter?: Record<string, unknown> } = {},
  ): Promise<Note> {
    this.assertExists();
    const rel = this.withExtension(relPath);
    const abs = this.resolve(rel);
    if (fs.existsSync(abs) && !opts.overwrite) {
      throw new VaultError(
        `Note already exists: ${rel}. Use update_note to overwrite it.`,
      );
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });

    const incoming = parseFrontmatter(content);
    const template = renderTemplate({
      ...this.frontmatterTemplate,
      ...opts.frontmatter,
    });
    const merged = { ...template, ...incoming.frontmatter };
    const final = Object.keys(merged).length
      ? `${stringifyFrontmatter(merged)}\n${incoming.body.replace(/^\n+/, "")}`
      : incoming.body;

    await fsp.writeFile(abs, ensureTrailingNewline(final), "utf8");
    return this.readNote(rel);
  }

  async updateNote(relPath: string, content: string): Promise<Note> {
    this.assertExists();
    const rel = this.withExtension(relPath);
    const abs = this.resolve(rel);
    if (!fs.existsSync(abs)) {
      throw new VaultError(
        `Note not found: ${rel}. Use create_note to make a new note.`,
      );
    }
    await fsp.writeFile(abs, ensureTrailingNewline(content), "utf8");
    return this.readNote(rel);
  }

  async appendToNote(relPath: string, text: string): Promise<Note> {
    const note = await this.readNote(relPath);
    const sep = note.content.endsWith("\n") ? "" : "\n";
    await fsp.writeFile(
      this.resolve(note.path),
      `${note.content}${sep}${text}\n`,
      "utf8",
    );
    return this.readNote(note.path);
  }

  /* ---------------------------------------------------------------- */
  /* get_backlinks                                                    */
  /* ---------------------------------------------------------------- */

  async getBacklinks(relPath: string): Promise<Backlink[]> {
    this.assertExists();
    const target = this.withExtension(relPath);
    const targetAbs = this.resolve(target);
    const targetRel = this.toRelative(targetAbs);
    const basename = path
      .basename(targetRel)
      .replace(/\.(md|markdown)$/i, "")
      .toLowerCase();
    const noExt = targetRel.replace(/\.(md|markdown)$/i, "").toLowerCase();

    const files = await this.allNotes();
    const out: Backlink[] = [];

    for (const rel of files) {
      if (rel === targetRel) continue;
      let content: string;
      try {
        content = await fsp.readFile(this.resolve(rel), "utf8");
      } catch {
        continue;
      }
      const links = extractLinks(content);
      const linked = links.some((l) => {
        const norm = l.replace(/\.(md|markdown)$/i, "").toLowerCase();
        return norm === basename || norm === noExt || norm.endsWith(`/${basename}`);
      });
      if (!linked) continue;

      const context = content
        .split("\n")
        .filter((line) => extractLinks(line).length > 0)
        .filter((line) => {
          const lower = line.toLowerCase();
          return lower.includes(basename) || lower.includes(noExt);
        })
        .slice(0, 3)
        .map((l) => l.trim());

      out.push({
        path: rel,
        title: path.basename(rel).replace(/\.(md|markdown)$/i, ""),
        context,
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* get_tags                                                         */
  /* ---------------------------------------------------------------- */

  async getTags(): Promise<{ tag: string; count: number; notes: string[] }[]> {
    this.assertExists();
    const files = await this.allNotes();
    const tally = new Map<string, Set<string>>();

    for (const rel of files) {
      let content: string;
      try {
        content = await fsp.readFile(this.resolve(rel), "utf8");
      } catch {
        continue;
      }
      for (const tag of extractTags(content)) {
        if (!tally.has(tag)) tally.set(tag, new Set());
        tally.get(tag)!.add(rel);
      }
    }

    return Array.from(tally.entries())
      .map(([tag, notes]) => ({
        tag,
        count: notes.size,
        notes: Array.from(notes).slice(0, 20),
      }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /* ---------------------------------------------------------------- */
  /* get_daily_note                                                   */
  /* ---------------------------------------------------------------- */

  dailyNotePath(date?: string): string {
    const iso = normalizeDate(date);
    const folder = this.dailyNotesPath.replace(/^[/\\]+|[/\\]+$/g, "");
    return folder ? `${folder}/${iso}.md` : `${iso}.md`;
  }

  async getDailyNote(
    date?: string,
    create = true,
  ): Promise<{ note: Note; created: boolean }> {
    const rel = this.dailyNotePath(date);
    const abs = this.resolve(rel);
    if (fs.existsSync(abs)) {
      return { note: await this.readNote(rel), created: false };
    }
    if (!create) throw new VaultError(`Daily note does not exist: ${rel}`);
    const iso = normalizeDate(date);
    const note = await this.createNote(rel, `# ${iso}\n\n`, {
      frontmatter: { created: iso, tags: ["daily"] },
    });
    return { note, created: true };
  }

  /* ---------------------------------------------------------------- */
  /* create_link                                                      */
  /* ---------------------------------------------------------------- */

  async createLink(
    fromPath: string,
    toPath: string,
    label?: string,
  ): Promise<{ from: string; to: string; link: string; alreadyLinked: boolean }> {
    const from = await this.readNote(fromPath);
    const toRel = this.withExtension(toPath);
    const toAbs = this.resolve(toRel);
    if (!fs.existsSync(toAbs)) {
      throw new VaultError(
        `Target note not found: ${toRel}. Create it first with create_note.`,
      );
    }
    const targetName = path
      .basename(this.toRelative(toAbs))
      .replace(/\.(md|markdown)$/i, "");
    const link = label ? `[[${targetName}|${label}]]` : `[[${targetName}]]`;

    const existing = extractLinks(from.content).some(
      (l) => l.replace(/\.(md|markdown)$/i, "").toLowerCase() === targetName.toLowerCase(),
    );
    if (existing) {
      return { from: from.path, to: this.toRelative(toAbs), link, alreadyLinked: true };
    }

    const hasSection = /\n##\s+Related\s*\n/i.test(from.content);
    const addition = hasSection
      ? from.content.replace(/(\n##\s+Related\s*\n)/i, `$1- ${link}\n`)
      : `${from.content.replace(/\s*$/, "")}\n\n## Related\n- ${link}\n`;

    await fsp.writeFile(this.resolve(from.path), ensureTrailingNewline(addition), "utf8");
    return { from: from.path, to: this.toRelative(toAbs), link, alreadyLinked: false };
  }

  async stats(): Promise<{ notes: number; folders: number; bytes: number }> {
    const notes = await this.allNotes();
    let bytes = 0;
    const folders = new Set<string>();
    for (const rel of notes) {
      const dir = path.dirname(rel);
      if (dir && dir !== ".") folders.add(dir);
      try {
        bytes += (await fsp.stat(this.resolve(rel))).size;
      } catch {
        /* ignore */
      }
    }
    return { notes: notes.length, folders: folders.size, bytes };
  }
}

/* ------------------------------------------------------------------ */
/* Markdown / frontmatter helpers                                      */
/* ------------------------------------------------------------------ */

/** Minimal YAML-frontmatter parser — enough for Obsidian's flat key/value + list style. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(rawLine);
    if (listItem && currentKey) {
      const arr = (frontmatter[currentKey] as unknown[]) || [];
      arr.push(parseScalar(listItem[1]));
      frontmatter[currentKey] = arr;
      continue;
    }

    const kv = /^([A-Za-z0-9_.\- ]+):\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (value === "") {
      frontmatter[key] = [];
      currentKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => parseScalar(s.trim()))
        .filter((s) => s !== "");
      currentKey = null;
    } else {
      frontmatter[key] = parseScalar(value);
      currentKey = null;
    }
  }

  return { frontmatter, body: content.slice(match[0].length) };
}

function parseScalar(v: string): unknown {
  const s = v.replace(/^["']|["']$/g, "");
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !Number.isNaN(Number(s)) && /^-?\d+(\.\d+)?$/.test(s)) {
    return Number(s);
  }
  return s;
}

export function stringifyFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${formatScalar(item)}`);
      }
    } else if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function formatScalar(v: unknown): string {
  const s = String(v);
  return /[:#\[\]{}]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** Expand {{date}}, {{time}}, {{datetime}} in a frontmatter template. */
export function renderTemplate(
  template: Record<string, unknown>,
  now = new Date(),
): Record<string, unknown> {
  const iso = now.toISOString();
  const replacements: Record<string, string> = {
    "{{date}}": iso.slice(0, 10),
    "{{time}}": iso.slice(11, 19),
    "{{datetime}}": iso,
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (typeof v === "string" && replacements[v] !== undefined) {
      out[k] = replacements[v];
    } else if (typeof v === "string") {
      out[k] = Object.entries(replacements).reduce(
        (acc, [token, val]) => acc.split(token).join(val),
        v,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** All wikilink targets and relative markdown-link targets in a chunk of text. */
export function extractLinks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    out.push(m[1].trim());
  }
  for (const m of content.matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)) {
    out.push(decodeURIComponent(m[1].trim()));
  }
  return out;
}

/** Tags from frontmatter (`tags:`) plus inline `#tags`, normalized without `#`. */
export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  const { frontmatter, body } = parseFrontmatter(content);

  const fmTags = frontmatter.tags ?? frontmatter.tag;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (t) tags.add(String(t).replace(/^#/, ""));
  } else if (typeof fmTags === "string") {
    for (const t of fmTags.split(/[,\s]+/)) if (t) tags.add(t.replace(/^#/, ""));
  }

  // Inline tags, skipping fenced code blocks and markdown headings.
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  for (const line of withoutCode.split("\n")) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) continue;
    for (const m of line.matchAll(/(?:^|\s)#([A-Za-z0-9_][\w/-]*)/g)) {
      tags.add(m[1]);
    }
  }
  return Array.from(tags);
}

function snippet(line: string, terms: string[]): string {
  const trimmed = line.trim();
  if (trimmed.length <= 200) return trimmed;
  const lower = trimmed.toLowerCase();
  const idx = Math.max(0, Math.min(...terms.map((t) => {
    const i = lower.indexOf(t);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  })) - 60);
  return (idx > 0 ? "…" : "") + trimmed.slice(idx, idx + 200) + "…";
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

/** Accept `today`, `yesterday`, `tomorrow`, `-1`, or an ISO date. */
export function normalizeDate(input?: string): string {
  const today = new Date();
  if (!input || input.toLowerCase() === "today") return isoDate(today);
  const lower = input.toLowerCase().trim();
  if (lower === "yesterday") return isoDate(new Date(today.getTime() - 86400000));
  if (lower === "tomorrow") return isoDate(new Date(today.getTime() + 86400000));
  if (/^[+-]\d+$/.test(lower)) {
    return isoDate(new Date(today.getTime() + Number(lower) * 86400000));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) return lower;
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) return isoDate(parsed);
  throw new VaultError(
    `Unrecognized date "${input}". Use YYYY-MM-DD, "today", "yesterday", or an offset like "-1".`,
  );
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
