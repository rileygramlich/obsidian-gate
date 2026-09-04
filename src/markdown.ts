/**
 * Markdown and frontmatter helpers.
 *
 * Deliberately free of any Obsidian or Node import so the same functions run
 * inside the plugin and inside a plain `node --test` run.
 */

export class GateError extends Error {}

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
  return /[:#[\]{}]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
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
    if (typeof v === "string") {
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

/** Trim a matching line down to a readable snippet centred on the first term. */
export function snippet(line: string, terms: string[]): string {
  const trimmed = line.trim();
  if (trimmed.length <= 200) return trimmed;
  const lower = trimmed.toLowerCase();
  const first = Math.min(
    ...terms.map((t) => {
      const i = lower.indexOf(t);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    }),
  );
  const idx = Math.max(0, (first === Number.MAX_SAFE_INTEGER ? 0 : first) - 60);
  return (idx > 0 ? "…" : "") + trimmed.slice(idx, idx + 200) + "…";
}

export function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function ensureTrailingNewline(s: string): string {
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
  throw new GateError(
    `Unrecognized date "${input}". Use YYYY-MM-DD, "today", "yesterday", or an offset like "-1".`,
  );
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Reject paths that would escape the vault or hit Obsidian's own config.
 * The vault API is already sandboxed, but a clear error beats a confusing one.
 */
export function normalizeVaultPath(input: string, { markdown = true } = {}): string {
  const raw = String(input ?? "").trim().replace(/^\/+/, "");
  if (!raw) throw new GateError("Path is required.");
  if (raw.includes("\\")) {
    throw new GateError("Use forward slashes in vault paths.");
  }
  const parts = raw.split("/");
  if (parts.some((p) => p === "." || p === "..")) {
    throw new GateError(`Path escapes the vault: ${input}`);
  }
  if (parts[0] === ".obsidian") {
    throw new GateError("The .obsidian config folder is off limits.");
  }
  const joined = parts.join("/");
  if (markdown && !/\.(md|markdown|canvas)$/i.test(joined)) return `${joined}.md`;
  return joined;
}
