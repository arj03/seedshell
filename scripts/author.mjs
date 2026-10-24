// The author key that signs every bundle here, and each app's version count. The first
// build mints the key.
//
// One key signs every app. Versions are counted per app, since the runtime's freshness store
// keys on (author, app). Both live in the repo root, not in bundle/ (which gets wiped), so
// the count never silently restarts at 1.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hybridAuthorKeysFromSeed } from "seedkernel-wasm/bundle-author";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = join(root, "chat-author.key");
/** Whether this run minted the key (then no version files are expected). */
let minted = false;

/** The author key set, minting the key file if missing. */
export function authorKeys(sodium) {
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, Buffer.from(sodium.crypto_sign_keypair().privateKey).toString("hex"), { mode: 0o600 });
    minted = true;
    console.log(`  minted author key → ${keyPath}`);
  }
  const sk = Uint8Array.from(Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex"));
  return hybridAuthorKeysFromSeed(sodium, sk.slice(0, 32));
}

const versionPath = (app) => join(root, `${app}-author.version`);

/** The next version for `app`: one past its last recorded version. */
export function nextVersion(app) {
  const path = versionPath(app);
  if (existsSync(path)) {
    const v = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(v) && v > 0) return v + 1;
  } else if (!minted) {
    // The key exists but this app has no count: either it's new, or the count was lost. Only
    // the author knows which, so warn instead of silently starting at 1.
    console.warn(
      `  ${app}: no version count yet (${path}), so this is version 1.\n` +
      `    If ${app} has shipped under this author before, put the last version shipped ` +
      `in that file and build again.`);
  }
  return 1;
}

/** Record `version` as the latest built for `app`. */
export function saveVersion(app, version) {
  writeFileSync(versionPath(app), `${version}\n`);
}
