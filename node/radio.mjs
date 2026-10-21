// The radio: a node with no page that sits in a jam room with a directory of music behind
// it. Whoever is in the room looks through that music from jam's view, and plays from it.
//
//   npm run radio -- <music directory> [--room <name>] [--relay <ws://host:port>]
//                    [--relay-secret <secret>] [--nick <name>] [--key <file>]
//
//   npm run radio -- ~/Music --room cats
//
// It runs the radio app (assembly/radio-app, built to bundle/radio.skb) in the headless
// shell (node/shell.mjs). The bundle's guest is jam's own, so the radio speaks `jam` as
// jam does; its head is jam's room (assembly/jam-app/room.js) and what the radio adds to
// one (assembly/radio-app/head.js). This file is what the head is handed: the directory,
// as a library of titles.
//
// The room defaults to `global` and the relay to the one `npm run relay` starts, which are
// where a tab of the shell is by default. The node's key is kept in `radio.key`, so the
// radio is the same peer each time it is started.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCrypto } from "seedkernel-wasm";
import { hostApp, toHex, fromHex } from "./shell.mjs";
import { ROOM_NAME_RE } from "../browser/peers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The files a library takes: the two formats jam can cut (assembly/jam-app/formats.js). */
const AUDIO = /\.(flac|ogg|oga)$/i;

function usage(why) {
  if (why) console.error(`radio: ${why}`);
  console.error("usage: npm run radio -- <music directory> [--room <name>] [--relay <ws://host:port>]\n" +
    "                         [--relay-secret <secret>] [--nick <name>] [--key <file>]");
  process.exit(2);
}

const flags = { room: "global", relay: "ws://localhost:8080", "relay-secret": null, nick: "radio", key: "radio.key" };
let dir = null;
for (let args = process.argv.slice(2), i = 0; i < args.length; i++) {
  const name = args[i].startsWith("--") ? args[i].slice(2) : null;
  if (name === null && dir === null) dir = args[i];
  else if (name !== null && Object.hasOwn(flags, name) && i + 1 < args.length) flags[name] = args[++i];
  else usage(`${args[i]} is not something it takes`);
}
if (dir === null) usage();
dir = resolve(dir);
if (!existsSync(dir)) usage(`there is no ${dir}`);
if (!ROOM_NAME_RE.test(flags.room)) usage("a room's name is 1 to 128 of A-Z a-z 0-9 . _ -");
let relay;
try { relay = new URL(flags.relay); } catch { usage(`${flags.relay} is not a relay's address`); }
if (relay.protocol !== "ws:" && relay.protocol !== "wss:") usage("a relay's address is ws:// or wss://");
if (Number(process.versions.node.split(".")[0]) < 22) usage("it dials the relay with the platform's WebSocket, which is Node 22's and later's");
const bundlePath = join(root, "bundle", "radio.skb");
if (!existsSync(bundlePath)) usage(`${bundlePath} not found: run \`npm run build\` first`);

// ── the directory, as a library ───────────────────────────────────────────────

/** Every audio file under the directory, each by its path from it, with `/` between its
 *  parts whatever the platform. A folder that cannot be read is passed over. A folder's
 *  entries are looked at together, not one after another. */
async function walk(under = "") {
  const entries = await readdir(join(dir, under), { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.map(async (entry) => {
    const path = under ? `${under}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(path);
    if (!entry.isFile() || !AUDIO.test(entry.name)) return [];
    const size = await stat(join(dir, path)).then((s) => s.size, () => -1);
    return size > 0 ? [{ path, size }] : [];
  }));
  return found.flat();
}

/** A file as jam reads one (assembly/jam-app/room.js `addTrack`): the bytes `[start, end)`
 *  of the one at `path`, read from disk when they are asked for, so a title in a room's
 *  list is served from the file as it is. Why one could not be read is this machine's
 *  business, and a peer is told only that it could not. */
function fileAt(path, start, end) {
  const size = end - start;
  const clamp = (n) => Math.max(0, Math.min(n, size));
  return {
    size,
    slice: (a = 0, b = size) => fileAt(path, start + clamp(a), start + Math.max(clamp(a), clamp(b))),
    async arrayBuffer() {
      const bytes = new Uint8Array(size);
      let file;
      try {
        file = await open(path);
        const { bytesRead } = await file.read(bytes, 0, size, start);
        if (bytesRead !== size) throw new Error("it is shorter than it was");
      } catch { throw new Error("its file can no longer be read"); }
      finally { await file?.close(); }
      return bytes.buffer;
    },
  };
}

const inOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
const music = {
  titles: async () => (await walk()).sort((a, b) => inOrder(a.path, b.path)),
  open: async (path) => {
    const at = join(dir, path);
    const size = await stat(at).then((s) => s.size, () => { throw new Error("its file can no longer be read"); });
    return fileAt(at, 0, size);
  },
};

// ── the node ──────────────────────────────────────────────────────────────────

const sodium = await loadCrypto();

/** This node's keypair, from the key file, minted if there is none: an Ed25519 secret key
 *  in hex, which holds its public half. */
function identityAt(path) {
  if (!existsSync(path)) {
    writeFileSync(path, toHex(sodium.crypto_sign_keypair().privateKey) + "\n", { mode: 0o600 });
    console.log(`minted the radio's key → ${path}`);
  }
  const privateKey = fromHex(readFileSync(path, "utf8").trim());
  if (privateKey.length !== 64) usage(`${path} does not hold a key`);
  return { publicKey: privateKey.slice(32), privateKey };
}

console.log(`the radio plays from ${dir}`);
const node = await hostApp({
  sodium,
  identity: identityAt(resolve(flags.key)),
  nick: flags.nick,
  relay: `${relay.protocol}//${relay.host}`,
  relaySecret: flags["relay-secret"],
  rooms: [flags.room],
  bundle: new Uint8Array(readFileSync(bundlePath)),
  head: ["jam-app/formats.js", "jam-app/room.js", "radio-app/head.js"].map((rel) => join(root, "assembly", rel)),
  grants: { music },
});

process.on("SIGINT", () => {
  node.close();
  process.exit(0);
});
