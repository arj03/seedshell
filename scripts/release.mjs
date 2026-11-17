// Cuts a release: builds and tests this checkout, packages it (scripts/package.mjs), tags
// HEAD as v<package.json version> and opens a draft GitHub release carrying the page as a
// zip and the apps as their own .skb files, for review and publish.
//
// The bundles are signed here by chat-author.key, so there is no workflow: a release is
// cut by the author. It refuses unless this tree and the sibling seedkernel and seedrelay
// it vendors from are clean, and the smoke and browser tests pass. The notes name the
// seedkernel and seedrelay it was built with, and the author the bundles are signed by.
// The page carries the host blob seedkernel published, downloaded from its release.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const tag = "v" + version;
const run = (cmd, ...args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && cmd === "npm" });
const read = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

if (read(root, "status", "--porcelain", "--untracked-files=no")) throw new Error("working tree is not clean; commit first");
const siblings = {};
for (const name of ["seedkernel", "seedrelay"]) {
  const dir = resolve(root, "..", name);
  if (read(dir, "status", "--porcelain", "--untracked-files=no")) throw new Error(`../${name} is not clean; the page must be built from a commit`);
  siblings[name] = read(dir, "describe", "--tags", "--always");
}
// Only a published tag is binding: a local one left by a failed run is moved to HEAD.
const published = read(root, "ls-remote", "origin", `refs/tags/${tag}`).split("\t")[0];
if (published && published !== read(root, "rev-parse", "HEAD")) throw new Error(`${tag} is already published on another commit`);

run("npm", "run", "build");

// The page must run the published host, so the host blob it carries is the one the
// seedkernel release carries, signed by its host author, in place of the one this
// checkout's build signed. The browser test then runs the page on it.
const kernelTag = read(resolve(root, "../seedkernel"), "describe", "--tags", "--abbrev=0");
const hostWeb = await fetch(`https://github.com/arj03/seedkernel/releases/download/${kernelTag}/host-web.skb`);
if (!hostWeb.ok) throw new Error(`seedkernel ${kernelTag} has no published host-web.skb (${hostWeb.status})`);
writeFileSync(resolve(root, "browser/vendor/host-web.skb"), Buffer.from(await hostWeb.arrayBuffer()));

run("npm", "run", "smoke");
run("npm", "run", "e2e");
const { APPS } = await import("./package.mjs"); // writes release/
const author = readFileSync(resolve(root, "browser/shell-bundle.js"), "utf8").match(/_AUTHOR_HEX = "([0-9a-f]+)"/)[1];
const zip = `release/seedshell-${version}.zip`;
const notes = `Built with seedkernel ${siblings.seedkernel}, running the host it published as ${kernelTag}, and seedrelay ${siblings.seedrelay}. Every bundle is signed by author \`${author}\`.

**The page.** Unzip \`seedshell-${version}.zip\` on any static web server and open \`seedshell/\`. It needs HTTPS beyond \`localhost\`, and a [seedrelay](https://github.com/arj03/seedrelay) its users can reach.

**The apps.** ${APPS.map((a) => `\`${a}.skb\``).join(", ")}: download one and drop it on the shell's **Apps** tab.
`;
run("git", "tag", "-f", tag);
run("git", "push", "origin", tag);
run("gh", "release", "create", tag, "--draft", "--verify-tag", "--title", tag, "--notes", notes, "--generate-notes",
  zip, ...APPS.map((a) => `release/${a}.skb`));
console.log(`\n${tag}: draft release created; review and publish it (gh release view ${tag} --web)`);
