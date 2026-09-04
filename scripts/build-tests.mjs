/** Bundle test/entry.ts so the plain-node test suite can import the plugin's logic. */
import esbuild from "esbuild";
import builtins from "builtin-modules";

await esbuild.build({
  entryPoints: ["test/entry.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  external: ["obsidian", ...builtins, ...builtins.map((m) => `node:${m}`)],
  outfile: "test/.build/gate.mjs",
  logLevel: "warning",
});
