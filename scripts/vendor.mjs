// Copy seedkernel's built host, its host blob and seedrelay's room client into
// browser/vendor/, so a plain static server can serve the shell (shell.html's import map
// points here).
//
// The whole `build-min` tree is copied, since its modules import siblings by relative path.
// Falls back to the readable `build/` if the minified one doesn't exist.

import { cpSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// seedkernel is a sibling checkout (package.json pins `file:../seedkernel/WASM`), so use
// that path directly.
const pkgRoot = resolve(root, "..", "seedkernel", "WASM");
if (!existsSync(pkgRoot)) {
  console.error(
    `seedkernel-wasm not found at ${pkgRoot}.\n` +
    "  check it out beside this repo, then: cd WASM && npm install && npm run build"
  );
  process.exit(2);
}

// Prefer the minified tree; fall back to build/ if only `build:host` was run.
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

// Staleness guard: if build/ was recompiled but the minify step wasn't re-run, the browser
// would get stale code while seedkernel's own tests (which use build/) still pass. Fail if
// any .js under build/host or build/services is newer than its build-min counterpart.
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

// Copy the whole tree (host modules import ../services/* by relative path).
cpSync(hostSrc, resolve(vendor, "seedkernel"), { recursive: true });

// The host blob: qjs.wasm, libsodium and ML-DSA-65 (§12.4), the same bytes Node and native
// nodes run, so the shell admits exactly the bundles they admit.
{
  const src = resolve(rawDir, "host.skb");
  if (!existsSync(src)) {
    console.error("missing build/host.skb — in the seedkernel checkout: cd WASM && npm run build");
    process.exit(2);
  }
  copyFileSync(src, resolve(vendor, "host.skb"));
}

// ── seedrelay's room client (sibling checkout, `file:../seedrelay`) ──────────
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
console.log("     the browser keep a STALE vendor/seedkernel after a rebuild → confusing errors.");
console.log("  relay + shell:  npm run relay  →  http://localhost:3000/shell.html");
