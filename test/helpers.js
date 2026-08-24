/** Shared scaffolding: every test file gets its own throwaway config home + vault. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create an isolated OBSIDIAN_AGENT_HOME. Must run before importing dist modules. */
export function useTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "og-home-"));
  process.env.OBSIDIAN_AGENT_HOME = home;
  return home;
}

/** Build a small vault on disk and return a VaultConfig for it. */
export function makeVault(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "og-vault-"));
  const contents = Object.keys(files).length ? files : DEFAULT_NOTES;
  for (const [rel, body] of Object.entries(contents)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return {
    name: path.basename(root),
    path: root,
    daily_notes_path: "Daily/",
    frontmatter_template: { created: "{{date}}", tags: [] },
  };
}

export const DEFAULT_NOTES = {
  "Projects/Alpha.md":
    "---\ntags: [project, active]\n---\n# Alpha\n\nDepends on [[Beta]]. Keyword: pineapple.\n",
  "Projects/Beta.md": "# Beta\n\nNo links here. #standalone\n",
  "Daily/2026-01-02.md": "# 2026-01-02\n\nMentions [[Beta]] once.\n",
};
