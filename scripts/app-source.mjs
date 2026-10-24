// Read an app's source directory into the input for `authorBundle`. Used by both the
// builder and smoke.mjs, so the test signs exactly what the builder would.
//
// An app is a directory with an `app.json`. Paths in it are relative to it; only `app` and
// `api` are required:
//
//   app           the install label (also its fs and signing scope)
//   api           the shell contract version (browser/app-api.js `APP_API`)
//   name, version, description   shown on its row in the shell
//   protocols     protocol ids it claims; default: [app]. Also given to the guest as
//                 `APP.protocols`
//   requires      what its guest may reach (`_net`, `fs`, `timer`); default: ["_net"]
//   guest         guest source files, concatenated in order after seedkernel's op-frame.
//                 Default: the room pipe (assembly/guest-lib)
//   ui            its view, an HTML page; omit for no UI. Linked CSS/JS is inlined
//                 (`readView`)
//   modules       pure wasm modules by name; `.ts` entries are compiled with AssemblyScript
//   boot          true for a shell boot bundle, loaded by pin rather than installed

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NET_PROTO, appFacts } from "../browser/app-api.js";

/** Allowed labels. The label names the version file, so it must be filename-safe. */
const APP_LABEL = /^[A-Za-z0-9_-]{1,64}$/;

/** Read as LF: these bytes are signed, and must not depend on the checkout's line endings. */
const lf = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** A file from assembly/guest-lib. */
const GUEST_LIB = join(dirname(fileURLToPath(import.meta.url)), "../assembly/guest-lib");
export const guestLib = (name) => lf(join(GUEST_LIB, name));

/** The guest for an app that names none: the room pipe. */
const PIPE_GUEST = ["net.js", "context.js", "room-pipe.js"];

/** AssemblyScript flags. Output stays in memory; only the signed bytes matter. */
const ASC_FLAGS = ["--optimizeLevel", "3", "--shrinkLevel", "2", "--noAssert", "--exportRuntime", "--maximumMemory", "256"];

/** A module's wasm: a `.wasm` file as-is, or a `.ts` AssemblyScript entry compiled. */
async function moduleWasm(path) {
  if (!path.endsWith(".ts")) return new Uint8Array(readFileSync(path));
  const { main } = await import("assemblyscript/asc");
  let wasm = null;
  const { error, stderr } = await main([path, "--outFile", "module.wasm", ...ASC_FLAGS],
    { writeFile: (name, contents) => { if (name.endsWith(".wasm")) wasm = contents; } });
  if (error || !wasm) throw new Error(`${path} did not compile:\n${stderr.toString()}`);
  return new Uint8Array(wasm);
}

/** The view at `rel` as one self-contained page. A view runs from a blob: URL with nothing
 *  beside it to fetch, so stylesheets (`<link rel="stylesheet">`) and scripts (`<script src>`)
 *  are inlined. Each must be a relative path (a sibling file, or assembly/view-lib). `text`
 *  reads an app file as LF text. */
function readView(rel, text) {
  const beside = (ref, close) => {
    if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(ref))
      throw new Error(`${rel}: "${ref}" must be a file named by its path from the view, which is all a view can carry`);
    const body = text(join(dirname(rel), ref));
    // The inlined text must not contain its own closing tag.
    if (body.toLowerCase().includes(close))
      throw new Error(`${rel}: ${ref} contains "${close}", which would end it early inside the page`);
    return body.endsWith("\n") ? body : body + "\n";
  };
  return text(rel)
    .replace(/<link\b[^>]*>/gi, (tag) => {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag) || !href) return tag;
      return `<style>\n${beside(href, "</style")}</style>`;
    })
    .replace(/<script\b([^>]*?)\s*\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
      (tag, before, src, after) => `<script${before}${after}>\n${beside(src, "</script")}</script>`);
}

/** Everything `authorBundle` needs for the app in `appDir` except `version` (the author's
 *  count), plus `boot`. `guestOpFraming` comes from seedkernel-wasm/bundle-author. */
export async function readAppSource(appDir, guestOpFraming) {
  const text = (rel) => lf(join(appDir, rel));
  const app = JSON.parse(text("app.json"));
  if (typeof app.app !== "string" || !APP_LABEL.test(app.app))
    throw new Error(`${appDir}/app.json: "app" must be 1-64 chars of [A-Za-z0-9_-]`);
  if (app.guest !== undefined && (!Array.isArray(app.guest) || app.guest.length === 0))
    throw new Error(`${appDir}/app.json: "guest" must list the guest's source files, or be left out for the room pipe`);
  const protocols = app.protocols ?? [app.app];
  const modules = [];
  for (const [name, rel] of Object.entries(app.modules ?? {})) modules.push({ name, wasm: await moduleWasm(join(appDir, rel)) });

  const source = {
    boot: app.boot === true,
    app: app.app,
    protocols,
    modules,
    guestSource: [guestOpFraming(), ...(app.guest ? app.guest.map(text) : PIPE_GUEST.map(guestLib))].join("\n"),
    guestRequires: app.requires ?? [NET_PROTO],
    guestConfig: {
      // The guest receives its config (`APP`) but not the manifest, so repeat the claims here.
      protocols,
      // What the shell reads (`appFacts`) lives in the signed manifest, so the app's name and
      // view are signed by the same key as its code.
      shell: {
        api: app.api,
        name: app.name ?? app.app,
        version: app.version ?? "",
        description: app.description ?? "",
        ...(app.ui ? { ui: readView(app.ui, text) } : {}),
      },
    },
  };
  // Refuse to sign what the shell would refuse to run.
  appFacts({ app: source.app, protocols: source.protocols, guest: { requires: source.guestRequires, config: source.guestConfig } });
  return source;
}
