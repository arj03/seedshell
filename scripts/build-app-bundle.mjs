// Build signed app bundles from app source directories: each app's guest, its view, its
// modules and a signed manifest declaring what it claims and reaches — the .skb the shell
// installs. This script is the offline producer holding the author key;
// browser/shell.js never signs, it only verifies and unpacks what this produces.
//
//   node scripts/build-app-bundle.mjs [app-dir …]
//
//   node scripts/build-app-bundle.mjs                     every app under assembly/
//   node scripts/build-app-bundle.mjs assembly/jam-app    just jam
//
// An app directory is one with an `app.json`, which is the only source of what the bundle
// is (scripts/app-source.mjs reads it, and compiles a module named by its AssemblyScript).
//
// Output: bundle/<label>.skb — the signed manifest + guest + modules packed into one blob
// (seedkernel §12.4).

import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCrypto } from "seedkernel-wasm";
import { authorBundle, guestOpFraming } from "seedkernel-wasm/bundle-author";
import { readAppSource } from "./app-source.mjs";
import { authorKeys, nextVersion, saveVersion } from "./author.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const assembly = join(root, "assembly");

const named = process.argv.slice(2).map((dir) => resolve(root, dir));
const appDirs = named.length > 0 ? named
  : readdirSync(assembly).map((name) => join(assembly, name)).filter((dir) => existsSync(join(dir, "app.json")));

const toHex = (b) => Buffer.from(b).toString("hex");

const sodium = await loadCrypto();

// The author key and each app's version are scripts/author.mjs's. Every build of an app is
// one lineage under its label, and the later build is the newer version. shell.js does not
// itself gate installs on it (installs are consent-gated, not freshness-gated, §12.4), but
// the offline author still keeps one true count rather than resetting to 1 on every run.
const keys = authorKeys(sodium);
mkdirSync(join(root, "bundle"), { recursive: true });

/** The directory each label was built from: a copied app that kept its label would
 *  otherwise overwrite the first one's bundle. */
const built = new Map();
for (const dir of appDirs) {
  const source = await readAppSource(dir, guestOpFraming);
  if (built.has(source.app))
    throw new Error(`${dir} and ${built.get(source.app)} are both the app "${source.app}": give one another label in its app.json`);
  built.set(source.app, dir);
  const version = nextVersion(source.app);
  const { blob, manifest, author } = authorBundle(sodium, keys, { ...source, version });
  saveVersion(source.app, version);
  const out = `bundle/${source.app}.skb`;
  writeFileSync(join(root, out), blob);

  // The pinned id is the derived author id (the key-set hash, §12.4) — a manifest is
  // signed by both halves of the key set, so the Ed25519 key alone is not what an
  // allow-list would pin. It is carried on the authorBundle value, not re-derived here.
  if (built.size === 1) console.log(`  author ${toHex(author)} (hybrid 0x02)`);
  const { name, version: label } = manifest.guest.config.shell;
  console.log(`  wrote ${out} (app ${manifest.app} v${manifest.version}, ${[name, label].filter(Boolean).join(" ")})`);
}
