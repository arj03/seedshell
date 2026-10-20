// Copy seedkernel's built host into browser/vendor/ so a plain static server can
// serve the shell with no bundler. The import map in shell.html points at these
// files; nothing else in this repo reaches into node_modules.
//
// This is deliberately a dumb copy of `build-min` wholesale: shell-core.js and
// bundle.js import their siblings and the `services/` tree by relative path, so the
// whole tree has to arrive intact even though the shell itself names only a handful
// of entry points. The minified tree is what seedstore's p2p.html vendors too —
// same convention across both apps — with the readable `build/` as a fallback.
//
// Beside it goes seedkernel's host blob (build/host.skb): the realm engine every guest
// runs on and the host's crypto, which the page fetches and hands to the browser platform
// (shell.js). The same blob the Node and native nodes run, so the page carries no crypto
// or engine of its own.

import { cpSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// seedkernel is a sibling checkout by declaration: package.json pins
// `file:../seedkernel/WASM`, and seedkernel is `private: true` and never published.
// So name that path, the same way seedstore's build-browser-demo.mjs does. Resolving
// it through Node instead would defend against install shapes the dependency spec has
// already ruled out, and would do it by reaching for `seedkernel-wasm/package.json` —
// a subpath that resolves only while seedkernel's `exports` map carries an entry
// nothing else needs.
const pkgRoot = resolve(root, "..", "seedkernel", "WASM");
if (!existsSync(pkgRoot)) {
  console.error(
    `seedkernel-wasm not found at ${pkgRoot}.\n` +
    "  check it out beside this repo, then: cd WASM && npm install && npm run build"
  );
  process.exit(2);
}

// The minified tree (build-min) is what seedkernel's own browser deployment
// vendors too, and is ~half the size of the readable build; fall back to the
// readable build when only that exists (a `npm run build:host` alone).
const minDir = resolve(pkgRoot, "build-min");
const rawDir = resolve(pkgRoot, "build");
const hostSrc = existsSync(minDir) ? minDir : rawDir;
if (!existsSync(hostSrc)) {
  console.error(
    `seedkernel-wasm is present but not built (${minDir} missing).\n` +
    "  in the seedkernel checkout: cd WASM && npm run build"
  );
  process.exit(2);
}
if (hostSrc === rawDir) {
  console.warn("note: vendoring the unminified host — run `npm run build:host:min` in seedkernel for the smaller build");
}

// ── staleness guard (same one seedstore's build-browser-demo.mjs runs) ──────
// The browser runs the MINIFIED host; seedkernel's own Node tests run build/.
// The two diverge silently when `build:host` (tsc) is re-run but `build:host:min`
// (minify) is not — a real trap after switching branches, because seedkernel's tests
// stay green against the fresh build/ while the shell vendors a stale build-min and runs
// old code. Catch it here, at the last step before the browser: if any compiled
// build/ .js is newer than the whole build-min tree, the minify step lagged.
// Scoped to the host/ and services/ subtrees — minify covers exactly those, and build/
// also holds asc fixture outputs (forwarder.*) that no tsc↔minify cycle touches.
function newestJsMtime(dir) {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) newest = Math.max(newest, newestJsMtime(p));
    else if (name.endsWith(".js")) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}
if (hostSrc === minDir && existsSync(rawDir)) {
  for (const sub of ["host", "services"]) {
    const rawDirSub = join(rawDir, sub), minDirSub = join(minDir, sub);
    if (!existsSync(rawDirSub) || !existsSync(minDirSub)) continue;
    const raw = newestJsMtime(rawDirSub), min = newestJsMtime(minDirSub);
    if (raw > min + 1000) { // 1s slack for filesystem mtime granularity
      console.error(
        `seedkernel build-min is STALE: build/${sub} is newer, so the minify step did not\n` +
        "re-run after the last compile. The shell would vendor and serve old seedkernel code.\n" +
        "  fix: in the seedkernel checkout, cd WASM && npm run build"
      );
      process.exit(2);
    }
  }
}

const vendor = resolve(root, "browser/vendor");
rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

// The whole minified tree: host/ and services/ (host modules import ../services/* by
// relative path) plus the top-level ws/forwarder entry files, unused by the shell but
// part of the same tree.
cpSync(hostSrc, resolve(vendor, "seedkernel"), { recursive: true });

// The host blob: qjs.wasm, libsodium and ML-DSA-65 (manifest suite 0x02, §12.4), the same
// bytes the Node and native nodes run, so the shell admits exactly the bundles they admit.
// ML-KEM-768 is private content of the signed transport bundle; no loose browser artifact
// is needed for it.
{
  const src = resolve(rawDir, "host.skb");
  if (!existsSync(src)) {
    console.error("missing build/host.skb — in the seedkernel checkout: cd WASM && npm run build");
    process.exit(2);
  }
  copyFileSync(src, resolve(vendor, "host.skb"));
}

// ── vendor seedrelay's room client ──────────────────────────────────────────
// Rooms are the app's: the page meets peers in a relay room itself and hands them to the
// transport, which knows only keys and relays. seedrelay is a sibling checkout, like
// seedkernel (package.json pins `file:../seedrelay`).
const roomsSrc = resolve(root, "..", "seedrelay", "rooms.mjs");
if (!existsSync(roomsSrc)) {
  console.error(`seedrelay not found at ${dirname(roomsSrc)}.\n  check it out beside this repo`);
  process.exit(2);
}
mkdirSync(resolve(vendor, "seedrelay"), { recursive: true });
copyFileSync(roomsSrc, resolve(vendor, "seedrelay", "rooms.mjs"));

console.log("vendored seedkernel-wasm -> browser/vendor/");
console.log("serve it:   npm run serve        (re-vendors + http-server with caching OFF)");
console.log("  ── DO NOT use a plain `http-server` without -c-1: its default max-age=3600 makes");
console.log("     the browser keep a STALE vendor/host after a rebuild → confusing errors.");
console.log("  relay + shell:  npm run relay  →  http://localhost:3000/shell.html");
