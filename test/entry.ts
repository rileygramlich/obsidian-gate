/**
 * Test entry point.
 *
 * Bundles the modules that don't touch the Obsidian API so `node --test` can
 * exercise the protocol, the tool dispatcher, the HTTP server and the client
 * config writer without an Electron runtime.
 */
export * from "../src/markdown";
export * from "../src/tools";
export * from "../src/mcp";
export * from "../src/server";
export * from "../src/clients";
export * from "../src/settings";
