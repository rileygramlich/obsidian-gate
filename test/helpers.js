/**
 * Shared test setup.
 *
 * Every test runs against a throwaway OBSIDIAN_AGENT_HOME so a test run can
 * never read — or clobber — the developer's real ~/.obsidian-gate/config.json.
 * Vendor Stripe credentials are cleared for the same reason: no test should be
 * able to reach the live Stripe account.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Point config/activity at a fresh temp dir. Call before loadConfig(). */
export function useTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-gate-test-"));
  process.env.OBSIDIAN_AGENT_HOME = home;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_PERSONAL;
  delete process.env.STRIPE_PRICE_TEAM;
  delete process.env.OBSIDIAN_VAULT_PATH;
  delete process.env.OBSIDIAN_AGENT_LICENSE;
  delete process.env.PORT;
  return home;
}

/**
 * A second fixture, for tests that exercise reading/writing rather than path
 * resolution: nested folders, a note with frontmatter tags, and two notes
 * linking to a third so backlinks have something to find.
 */
export const PROJECT_NOTES = {
  "Projects/Alpha.md":
    "---\ntags: [project, active]\n---\n# Alpha\n\nDepends on [[Beta]]. Keyword: pineapple.\n",
  "Projects/Beta.md": "# Beta\n\nNo links here. #standalone\n",
  "01-Daily/2026-01-02.md": "# 2026-01-02\n\nMentions [[Beta]] once.\n",
};

/**
 * Build a small on-disk vault with a couple of notes.
 *
 * Pass `files` (a { relativePath: contents } map, e.g. PROJECT_NOTES) to lay
 * down a specific fixture instead of the default two-note vault.
 */
export function makeVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-vault-"));

  if (files) {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  } else {
    fs.mkdirSync(path.join(root, "01-Daily"), { recursive: true });
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "notes", "alpha.md"),
      "---\ntags: [project]\n---\n\n# Alpha\n\nLinks to [[beta]].\n",
    );
    fs.writeFileSync(path.join(root, "notes", "beta.md"), "# Beta\n\n#idea plain note\n");
  }

  return {
    name: "TestVault",
    path: root,
    daily_notes_path: "01-Daily/",
    frontmatter_template: { created: "{{date}}", tags: [] },
  };
}

export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Listen on an ephemeral port and return the real bound port. */
export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
