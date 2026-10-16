// Remove every build artifact so the next build starts from nothing.
//
// The build scripts overwrite in place rather than wiping their output dir, so a
// stale file from an earlier build — or a different branch — can linger and get
// served. `npm run clean` is the escape hatch: delete the vendored runtime, then
// `npm run build` regenerates it. Use it whenever the shell behaves like it's
// running old code and `-c-1` (see `npm run serve`) has already ruled out the
// browser cache.
//
//   npm run clean          →  removes browser/vendor/
//   npm run clean && npm run build
//
// rmSync retries through the transient Windows/Defender file locks that make a
// plain delete flaky right after a server or the browser touched the dir.

import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dir = join(root, "browser", "vendor");
if (existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log("clean: removed browser/vendor/ — run `npm run build` to regenerate.");
} else console.log("clean: nothing to do — browser/vendor/ is already absent.");
