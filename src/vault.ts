/**
 * Vault access through Obsidian's own API.
 *
 * The standalone server in server/ walks the filesystem; inside the plugin we
 * go through `app.vault` and `app.metadataCache` instead. That buys three
 * things the filesystem version can't have: no vault path to configure, writes
 * that Obsidian sees immediately, and link/tag data straight from the index
 * Obsidian already maintains.
 */
import {
  TFile,
  TFolder,
  normalizePath,
  type App,
  type CachedMetadata,
} from "obsidian";
import {
  GateError,
  ensureTrailingNewline,
  extractLinks,
  normalizeVaultPath,
  occurrences,
  parseFrontmatter,
  renderTemplate,
  snippet,
  stringifyFrontmatter,
} from "./markdown";

export interface NoteEntry {
  name: string;
  path: string;
  type: "note" | "folder";
  modified?: string;
  size?: number;
}

export interface Note {
  path: string;
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  content: string;
  modified: string;
  size: number;
}

export interface SearchHit {
  path: string;
  name: string;
  score: number;
  matches: { line: number; text: string }[];
}

export interface Backlink {
  path: string;
  name: string;
  context: string[];
}

export interface VaultOptions {
  /** Folder new daily notes land in, e.g. "01-Daily". */
  dailyNotesFolder: string;
  /** Frontmatter merged into every note this plugin creates. */
  frontmatterTemplate: Record<string, unknown>;
  /** Default cap on search results. */
  maxSearchResults: number;
}

export class GateVault {
  constructor(
    private readonly app: App,
    private readonly options: () => VaultOptions,
  ) {}

  get name(): string {
    return this.app.vault.getName();
  }

  /* ------------------------------ reads ------------------------------ */

  private file(path: string): TFile {
    const rel = normalizeVaultPath(path);
    const found = this.app.vault.getAbstractFileByPath(normalizePath(rel));
    if (found instanceof TFile) return found;
    throw new GateError(`No note at "${rel}".`);
  }

  /** Every markdown file in the vault, excluding Obsidian's own config folder. */
  private markdownFiles(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => !f.path.startsWith(".obsidian/"));
  }

  async listNotes(relPath = ""): Promise<NoteEntry[]> {
    const clean = String(relPath ?? "").trim().replace(/^\/+|\/+$/g, "");
    const target = clean
      ? this.app.vault.getAbstractFileByPath(normalizePath(clean))
      : this.app.vault.getRoot();

    if (!(target instanceof TFolder)) {
      throw new GateError(`No folder at "${clean || "/"}".`);
    }

    const entries: NoteEntry[] = [];
    for (const child of target.children) {
      if (child.path.startsWith(".obsidian")) continue;
      if (child instanceof TFolder) {
        entries.push({ name: child.name, path: child.path, type: "folder" });
      } else if (child instanceof TFile && /^(md|markdown)$/i.test(child.extension)) {
        entries.push({
          name: child.basename,
          path: child.path,
          type: "note",
          modified: new Date(child.stat.mtime).toISOString(),
          size: child.stat.size,
        });
      }
    }
    return entries.sort(
      (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
    );
  }

  async allNotes(): Promise<string[]> {
    return this.markdownFiles()
      .map((f) => f.path)
      .sort();
  }

  async readNote(relPath: string): Promise<Note> {
    const file = this.file(relPath);
    const content = await this.app.vault.cachedRead(file);
    const { frontmatter, body } = parseFrontmatter(content);
    return {
      path: file.path,
      name: file.basename,
      frontmatter,
      body,
      content,
      modified: new Date(file.stat.mtime).toISOString(),
      size: file.stat.size,
    };
  }

  async searchNotes(query: string, limit?: number): Promise<SearchHit[]> {
    const terms = String(query ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!terms.length) throw new GateError("Search query is empty.");

    const cap = limit || this.options().maxSearchResults;
    const hits: SearchHit[] = [];

    for (const file of this.markdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      const haystack = content.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) continue;

      // Title matches are worth more than body matches — a note called
      // "Kubernetes" beats one that mentions it in passing.
      const nameLower = file.basename.toLowerCase();
      let score = terms.reduce(
        (acc, t) => acc + occurrences(haystack, t) + (nameLower.includes(t) ? 10 : 0),
        0,
      );

      const matches: { line: number; text: string }[] = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < 3; i++) {
        const lower = lines[i].toLowerCase();
        if (terms.some((t) => lower.includes(t))) {
          matches.push({ line: i + 1, text: snippet(lines[i], terms) });
        }
      }

      hits.push({ path: file.path, name: file.basename, score, matches });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, cap);
  }

  /* ------------------------------ writes ----------------------------- */

  /** Create any missing parent folders for a vault-relative file path. */
  private async ensureFolder(filePath: string): Promise<void> {
    const dir = filePath.split("/").slice(0, -1).join("/");
    if (!dir) return;
    if (this.app.vault.getAbstractFileByPath(normalizePath(dir))) return;
    await this.app.vault.createFolder(normalizePath(dir)).catch((err: unknown) => {
      // A concurrent create is fine; anything else is real.
      if (!String(err).includes("already exists")) throw err;
    });
  }

  async createNote(
    relPath: string,
    content: string,
    opts: { frontmatter?: Record<string, unknown> } = {},
  ): Promise<Note> {
    const rel = normalizeVaultPath(relPath);
    if (this.app.vault.getAbstractFileByPath(normalizePath(rel))) {
      throw new GateError(`"${rel}" already exists. Use update_note to change it.`);
    }

    // Template frontmatter is the base; frontmatter already in the content and
    // the explicit argument both win over it, in that order.
    const parsed = parseFrontmatter(content ?? "");
    const merged = {
      ...renderTemplate(this.options().frontmatterTemplate),
      ...parsed.frontmatter,
      ...(opts.frontmatter ?? {}),
    };
    const full = Object.keys(merged).length
      ? `${stringifyFrontmatter(merged)}\n\n${parsed.body.trimStart()}`
      : parsed.body;

    await this.ensureFolder(rel);
    await this.app.vault.create(normalizePath(rel), ensureTrailingNewline(full));
    return this.readNote(rel);
  }

  async updateNote(relPath: string, content: string): Promise<Note> {
    const file = this.file(relPath);
    await this.app.vault.modify(file, ensureTrailingNewline(content ?? ""));
    return this.readNote(file.path);
  }

  async appendToNote(relPath: string, text: string): Promise<Note> {
    const file = this.file(relPath);
    await this.app.vault.append(file, ensureTrailingNewline(`\n${text ?? ""}`));
    return this.readNote(file.path);
  }

  /* --------------------------- links & tags -------------------------- */

  /**
   * Notes linking here. Obsidian's resolved-link index is the source of truth,
   * so aliases, shortest-path links and markdown links all resolve correctly.
   */
  async getBacklinks(relPath: string): Promise<Backlink[]> {
    const file = this.file(relPath);
    const resolved = this.app.metadataCache.resolvedLinks;
    const out: Backlink[] = [];

    for (const [sourcePath, targets] of Object.entries(resolved)) {
      if (sourcePath === file.path) continue;
      if (!targets[file.path]) continue;

      const source = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(source instanceof TFile)) continue;

      const content = await this.app.vault.cachedRead(source);
      const context = content
        .split("\n")
        .filter((line) =>
          extractLinks(line).some(
            (l) => this.resolveLinkPath(l, sourcePath) === file.path,
          ),
        )
        .slice(0, 3)
        .map((l) => l.trim());

      out.push({ path: source.path, name: source.basename, context });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private resolveLinkPath(link: string, sourcePath: string): string | null {
    const dest = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
    return dest ? dest.path : null;
  }

  async getTags(): Promise<{ tag: string; count: number; notes: string[] }[]> {
    const counts = new Map<string, { count: number; notes: Set<string> }>();

    for (const file of this.markdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      for (const tag of tagsFromCache(cache)) {
        const entry = counts.get(tag) ?? { count: 0, notes: new Set<string>() };
        entry.count += 1;
        entry.notes.add(file.path);
        counts.set(tag, entry);
      }
    }

    return Array.from(counts.entries())
      .map(([tag, v]) => ({ tag, count: v.count, notes: Array.from(v.notes).slice(0, 20) }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /* ---------------------------- daily note --------------------------- */

  dailyNotePath(date: string): string {
    const folder = this.options().dailyNotesFolder.replace(/^\/+|\/+$/g, "");
    return folder ? `${folder}/${date}.md` : `${date}.md`;
  }

  async getDailyNote(
    date: string,
    create: boolean,
  ): Promise<{ note: Note; created: boolean }> {
    const rel = this.dailyNotePath(date);
    const existing = this.app.vault.getAbstractFileByPath(normalizePath(rel));
    if (existing instanceof TFile) {
      return { note: await this.readNote(rel), created: false };
    }
    if (!create) throw new GateError(`No daily note for ${date} (at "${rel}").`);

    const note = await this.createNote(rel, `# ${date}\n\n`, {
      frontmatter: { date, type: "daily" },
    });
    return { note, created: true };
  }

  /* ------------------------------ linking ---------------------------- */

  async createLink(
    from: string,
    to: string,
    label?: string,
  ): Promise<{ from: string; to: string; alreadyLinked: boolean; link: string }> {
    const fromFile = this.file(from);
    const toFile = this.file(to);
    const content = await this.app.vault.read(fromFile);

    const alreadyLinked = extractLinks(content).some(
      (l) => this.resolveLinkPath(l, fromFile.path) === toFile.path,
    );
    const link = label
      ? `[[${toFile.basename}|${label}]]`
      : `[[${toFile.basename}]]`;

    if (alreadyLinked) {
      return { from: fromFile.path, to: toFile.path, alreadyLinked: true, link };
    }

    const hasSection = /^##\s+Related\s*$/m.test(content);
    const addition = hasSection
      ? content.replace(/^(##\s+Related\s*)$/m, `$1\n- ${link}`)
      : `${ensureTrailingNewline(content)}\n## Related\n\n- ${link}\n`;

    await this.app.vault.modify(fromFile, ensureTrailingNewline(addition));
    return { from: fromFile.path, to: toFile.path, alreadyLinked: false, link };
  }

  /* ------------------------------- stats ----------------------------- */

  async stats(): Promise<{ notes: number; folders: number; bytes: number }> {
    const files = this.markdownFiles();
    const folders = new Set<string>();
    let bytes = 0;
    for (const f of files) {
      bytes += f.stat.size;
      const dir = f.path.split("/").slice(0, -1).join("/");
      if (dir) folders.add(dir);
    }
    return { notes: files.length, folders: folders.size, bytes };
  }
}

/** Frontmatter tags plus inline tags, both straight from Obsidian's index. */
function tagsFromCache(cache: CachedMetadata | null): Set<string> {
  const tags = new Set<string>();
  if (!cache) return tags;

  for (const t of cache.tags ?? []) {
    if (t.tag) tags.add(t.tag.replace(/^#/, ""));
  }
  const fm = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
  if (Array.isArray(fm)) {
    for (const t of fm) if (t) tags.add(String(t).replace(/^#/, ""));
  } else if (typeof fm === "string") {
    for (const t of fm.split(/[,\s]+/)) if (t) tags.add(t.replace(/^#/, ""));
  }
  return tags;
}
