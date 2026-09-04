/**
 * Keep manifest.json and versions.json in step with package.json.
 *
 * Run by `npm version` — Obsidian reads the manifest, not package.json, and
 * versions.json is what tells older Obsidian installs which release they can
 * still use.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Set version ${version} (minAppVersion ${manifest.minAppVersion}).`);
