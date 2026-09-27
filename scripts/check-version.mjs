#!/usr/bin/env node
// package.json の version を単一の情報源として、plugin.json / marketplace.json のバージョンが
// ずれていないかを検証する(v0.2.0のバージョン一元化方針)。CIやリリース前に `npm run check:version` で実行する。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(rootDir, rel), "utf8"));

const pkgVersion = readJson("package.json").version;
const pluginVersion = readJson(".claude-plugin/plugin.json").version;
const marketplace = readJson(".claude-plugin/marketplace.json");
const marketplaceMetaVersion = marketplace.metadata.version;
const marketplacePluginVersion = marketplace.plugins.find((p) => p.name === "coeiroink")?.version;

const mismatches = [
  ["package.json", pkgVersion],
  [".claude-plugin/plugin.json", pluginVersion],
  [".claude-plugin/marketplace.json#metadata.version", marketplaceMetaVersion],
  [".claude-plugin/marketplace.json#plugins[coeiroink].version", marketplacePluginVersion],
].filter(([, v]) => v !== pkgVersion);

if (mismatches.length > 0) {
  console.error(`バージョン不一致: package.json は ${pkgVersion} ですが、以下が一致していません:`);
  for (const [where, v] of mismatches) console.error(`  - ${where}: ${v}`);
  process.exit(1);
}

console.log(`OK: すべて ${pkgVersion} で一致しています。`);
