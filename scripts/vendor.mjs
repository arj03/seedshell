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
// libsodium ships alongside because libsodium-wrappers.mjs resolves both its core
// module and its .wasm relative to its own URL (`new URL('./libsodium.wasm',
// import.meta.url)`), so the three files must stay in one directory.
//
// The QuickJS realm engine is vendored too: the transport bundle the shell admits runs
// as a confined guest program, on seedkernel's qjs.wasm, which the realm factory
// (host/engine-web.js) fetches from `../../browser/` relative to itself. So the vendored
// tree keeps seedkernel's own layout: the host in vendor/seedkernel/, the engine in
// vendor/browser/. Seedstore's build-browser-demo.mjs stages the same pair.

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
// part of the same tree. libsodium and mldsa65.wasm live in seedkernel's
// browser/ dir and are copied separately, below.
cpSync(hostSrc, resolve(vendor, "seedkernel"), { recursive: true });

for (const f of ["libsodium-wrappers.mjs", "libsodium-core.mjs", "libsodium.wasm"]) {
  const src = resolve(pkgRoot, "browser", f);
  if (!existsSync(src)) {
    console.error(`missing ${f} — in the seedkernel checkout: cd WASM && npm run build:browser-sodium`);
    process.exit(2);
  }
  cpSync(src, resolve(vendor, f));
}

// ML-DSA-65 for manifest suite 0x02 (§12.4). The same artifact Node reads and the native
// binary embeds, so the shell admits exactly the bundles they admit; it fetches the file
// by URL rather than importing it, so it does not need to sit beside a JS module.
{
  const src = resolve(pkgRoot, "browser/mldsa65.wasm");
  if (!existsSync(src)) {
    console.error("missing mldsa65.wasm — in the seedkernel checkout: cd WASM && npm run build:pq");
    process.exit(2);
  }
  cpSync(src, resolve(vendor, "mldsa65.wasm"));
}

// ML-KEM-768 is private content of the signed transport bundle now; no loose
// browser artifact is needed here.

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

// ── vendor the QuickJS realm engine so the shell runs offline ───────────────
// seedkernel's qjs.wasm, the engine every target runs, which `npm run build` copies
// into its browser/ dir. The vendored host/engine-web.js fetches it at
// ../../browser/qjs.wasm, which from vendor/seedkernel/host/ is vendor/browser/.
{
  const src = resolve(pkgRoot, "browser", "qjs.wasm");
  if (!existsSync(src)) {
    console.error("missing qjs.wasm — in the seedkernel checkout: cd WASM && npm run build");
    process.exit(2);
  }
  mkdirSync(resolve(vendor, "browser"), { recursive: true });
  copyFileSync(src, resolve(vendor, "browser", "qjs.wasm"));
}

console.log("vendored seedkernel-wasm -> browser/vendor/");
console.log("serve it:   npm run serve        (re-vendors + http-server with caching OFF)");
console.log("  ── DO NOT use a plain `http-server` without -c-1: its default max-age=3600 makes");
console.log("     the browser keep a STALE vendor/host after a rebuild → confusing errors.");
console.log("  relay + shell:  npm run relay  →  http://localhost:3000/shell.html");
