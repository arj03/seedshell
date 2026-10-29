// The headless shell: a node that hosts one app from a console, as browser/shell.js hosts
// several in a tab. It has an identity, a nick, a relay and rooms (browser/peers.js), but no
// contacts, offers or calls.
//
// The app is a signed bundle, admitted because whoever started the node named it. Its guest
// is driven through the same two ops as in the browser (browser/app-api.js). In place of a
// view it has a "head": plain scripts run in order behind the same interface a view gets,
// assembly/view-lib/app.js, which runs unchanged with a `window` whose parent is this
// shell. So a head has `app`, `toHex`, `fromHex` and `concat` just like a view.
//
// A head isn't part of the bundle and isn't confined: it's this node's own code, and gets
// whatever is passed in `grants` (the radio gets a music directory). Anything it sends still
// goes out through the app's guest, under the bundle's protocols.
//
// Node has no WebRTC, so all links stay relayed (§12.7). Needs Node 22+ for WebSocket.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

import { bootShell } from "seedkernel-wasm/shell-core";
import { writeOp } from "seedkernel-wasm/op-frame";
import { verifyBundle, genesisHash } from "seedkernel-wasm/bundle";
import { WsNetwork } from "seedkernel-wasm/net-ws";
import { MemoryFs } from "seedkernel-wasm/fs-memory";

import { APP_OP_CONTEXT, APP_OP_UI, MAX_QUEUED_RENDERS, admitGate, appFacts, bundleDigest, toHex, fromHex } from "../browser/app-api.js";
import { Peers } from "../browser/peers.js";
// The shell boot bundle, pinned as in the browser: used here to exchange nicks.
import { SHELL_PROTO, SHELL_OP_TELL } from "../browser/shell-app.js";
import { shellBundleBytes, SHELL_AUTHOR_HEX, SHELL_APP } from "../browser/shell-bundle.js";

export { toHex, fromHex };

/** The view interface, which heads use too. */
const VIEW_LIB = join(dirname(fileURLToPath(import.meta.url)), "../assembly/view-lib/app.js");

/** Run a node hosting the app in `bundle` (.skb bytes). `head` lists the head's script
 *  paths in order; `grants` are extra globals for it. The node uses `identity` and `nick`,
 *  registers on `relay` (`ws[s]://host[:port]`, `relaySecret` if private) and joins `rooms`.
 *  `say` receives status messages. Returns `{ key, close }`. */
export async function hostApp({ sodium, identity, nick = "", relay, relaySecret = null, rooms, bundle, head, grants = {}, say = console.log }) {
  const digest = (bytes) => genesisHash(sodium, bytes);
  const short = (key) => key.slice(0, 8);

  // Ignore transport status until the app is installed, and don't report relay state during
  // the first join (it would look like a dropped relay).
  let standing = false;
  let joining = true;
  const sayRelay = () => say(peers.relayState === 1 ? `on the relay at ${relay}` : peers.relayState === 2 ? `the relay at ${relay} is unreachable; retrying` : "on no relay");
  // Strip control characters from nicks before printing them to a terminal.
  const label = (key) => {
    const called = ((key === peers.me ? peers.nick : peers.nicks.get(key)) ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    return called ? `${called} (${short(key)})` : short(key);
  };

  // Relay state and linked peers (§12.6). All links here are relayed, so that isn't reported.
  function onStatus(status) {
    const relayWas = peers.relayState, linkedWas = [...peers.linked.keys()];
    peers.status(status);
    if (!standing) return;
    if (peers.relayState !== relayWas && !joining) sayRelay();
    for (const key of peers.linked.keys()) if (!linkedWas.includes(key)) say(`linked to ${label(key)}`);
    for (const key of linkedWas) if (!peers.linked.has(key)) say(`${label(key)} is gone`);
  }

  // Same gate as the page: the shell app by pin, plus a consent for the one named app.
  const consents = new Set();
  const { shell } = await bootShell({
    sodium, identity,
    services: {
      fs: new MemoryFs(),
      // Never idle out links (rooms keep members linked).
      transport: { channels: new WsNetwork(), onStatus: (s) => onStatus(s), config: { linkIdleTimeoutMs: 0 } },
    },
    admit: admitGate([{ author: SHELL_AUTHOR_HEX, app: SHELL_APP }], consents, digest),
  });

  const peers = new Peers({
    shell, identity, sodium,
    tell: async (key, notice) =>
      (await shellApp.invoke(writeOp(SHELL_OP_TELL, Uint8Array.from([...fromHex(key), ...notice]))))[0] === 1,
    changed: () => { if (standing) void tellContext(); },
    onRefused: (name) => say(`the room ${name} is full`),
  });
  peers.setNick(nick);

  // From shell/v1, keep peers' nicks. Contact notices, call signals and offers don't apply
  // to a headless node.
  const shellApp = await shell.install(shellBundleBytes(), {
    onInbound: (claim, from, answer) => {
      if (claim !== SHELL_PROTO || answer.length === 0) return;
      let said;
      try { said = JSON.parse(new TextDecoder().decode(answer)); } catch { return; }
      if (typeof said?.nick !== "string") return;
      peers.heardNick(toHex(from), said.nick);
      void tellContext();
    },
  });

  // ── the app, and its head ─────────────────────────────────────────────────
  const verified = verifyBundle(sodium, bundle);
  const facts = appFacts(verified.manifest);
  consents.add(toHex(bundleDigest(verified, digest)));
  const guest = await shell.install(bundle, { onInbound: (claim, from, answer) => render(answer) });

  // The head's `window`. Its parent is this shell: what the head posts goes to `fromHead`,
  // and `toHead` delivers messages to its listeners as if from the parent.
  const listeners = [];
  const parent = { postMessage: (msg) => queueMicrotask(() => fromHead(msg)) };
  const toHead = (msg) => {
    for (const fn of listeners) {
      try { fn({ source: parent, data: msg }); }
      catch (err) { say(`${facts.name}'s head: ${err.stack ?? err}`); }
    }
  };
  const window = { parent, addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); } };

  let ready = false;
  const queued = [];
  /** Deliver a guest's render to the head. Before it's ready, renders are queued, except
   *  context renders, since it gets a fresh context on ready. */
  function render(payload, isContext = false) {
    if (payload.length === 0) return;
    if (ready) { toHead({ type: "render", payload }); return; }
    if (isContext) return;
    queued.push(payload);
    if (queued.length > MAX_QUEUED_RENDERS) queued.shift();
  }

  /** Send the guest the context if it changed, and pass the answer to the head. */
  let told = null;
  async function tellContext() {
    const json = peers.context();
    if (!ready || json === told) return;
    told = json;
    try { render(await guest.invoke(writeOp(APP_OP_CONTEXT, new TextEncoder().encode(json))), true); }
    catch (err) {
      say(`${facts.name}: ${err.message}`);
      // Not delivered: forget it, so the next change tries again.
      if (told === json) told = null;
    }
  }

  /** Handle a message from the head, as the page handles a view's: `ready`, and `call`
   *  (answered under its id). `conv` and `contact` don't apply here. */
  function fromHead(msg) {
    if (msg?.type === "ready") {
      ready = true;
      void tellContext().then(() => { for (const p of queued.splice(0)) render(p); });
    } else if (msg?.type === "call") {
      guest.invoke(writeOp(APP_OP_UI, msg.bytes)).then((payload) => toHead({ type: "answer", id: msg.id, payload }), (err) => {
        say(`${facts.name}: ${err.message}`);
        toHead({ type: "answer", id: msg.id, error: err.message });
      });
    }
  }

  // The head's scripts share this process's global scope, as a page's scripts share the
  // page's, so a process runs one head.
  Object.assign(globalThis, { window, ...grants });
  for (const path of [VIEW_LIB, ...head]) {
    try { runInThisContext(readFileSync(path, "utf8"), { filename: path }); }
    catch (err) { say(`${facts.name}'s head: ${err.stack ?? err}`); throw err; }
  }

  // ── the relay and its rooms ───────────────────────────────────────────────
  standing = true;
  say(`${[facts.name, facts.version].filter(Boolean).join(" ")} is ${label(peers.me)}`);
  for (const name of rooms) await peers.joinRoom(name);
  await peers.joinRelay(relay, relaySecret);
  joining = false;
  sayRelay();

  return {
    key: peers.me,
    close() {
      peers.relay?.client.close();
      shell.close();
    },
  };
}
