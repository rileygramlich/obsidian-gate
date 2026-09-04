# Vault Gate

An Obsidian community plugin that runs an MCP server inside Obsidian. The repo
root is the plugin (Obsidian's store requires `manifest.json` there);
`server/` holds the older standalone Node CLI, which is independent.

## Build

```bash
npm install
npm run dev     # watch → main.js
npm run build   # tsc --noEmit + production bundle
npm test        # bundles test/entry.ts, then node --test
```

## Before releasing

1. `npm version <patch|minor|major>` — updates `manifest.json` and `versions.json`
2. `git push --follow-tags` — the release workflow builds and attaches
   `main.js`, `manifest.json`, `styles.css`
3. Obsidian's store reads the manifest from the repo root and the assets from
   the release, so both must carry the same version

## Conventions

- No new runtime dependencies. `main.js` bundles everything except Node
  builtins and `obsidian`; the MCP protocol is implemented directly rather than
  via the SDK to keep the bundle small and reviewable.
- Build DOM with `createEl`/`createSpan`/`setText`. Never `innerHTML` — the
  community-plugin review rejects it.
- Style with Obsidian's CSS variables in `styles.css`, not inline styles.
- `src/vault.ts` is the only file that may import from `obsidian` for runtime
  values besides the UI files; everything else stays testable in plain Node.

## The standalone CLI

`server/` is the pre-plugin product: a Node MCP server that reads a vault off
disk, with a dashboard and Stripe licensing. It is not built or shipped with
the plugin. Its own `npm test` runs from inside that directory.
