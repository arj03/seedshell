// The shell with no page: a node that hosts one app from a console, as browser/shell.js
// hosts several from a tab. It owns what that shell owns, less what only a person at a page
// has a use for: this node's identity and nick, the relay, its rooms and who is in them,
// and the links to them (browser/peers.js, which the page follows its peers through too).
// It has no contacts, takes no offers and holds no calls.
//
// The app is a signed bundle like any other, admitted because whoever started this node
// named it, which is what dropping its file on the page says. Its guest is driven through
// the same two ops (browser/app-api.js). What stands where a view would is a HEAD: plain
// script this shell runs in the order given, as a page runs a view's, behind the very door
// a view is given, assembly/view-lib/app.js. That file runs here as it is, with a `window`
// whose parent is this shell: what it posts is handled as the page handles a view's, and
// what this shell sends it arrives as a message from its parent. So a head has `app`,
// `toHex`, `fromHex` and `concat` exactly as a view has them.
//
// A head is not part of the bundle and is not confined: it is this node's own program, and
// reaches whatever it is handed here beside the door (`grants`), which is how the radio's
// comes by a directory of music. What it sends still leaves through the app's guest, under
// the protocols the bundle claims.
//
// Node has no WebRTC of its own, so every link of this node's stays on the relay, which
// forwards its encrypted bytes (seedkernel §12.7). It dials a relay with the platform's
// WebSocket, as the page does: Node 22 or later.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

import { bootShell } from "seedkernel-wasm/shell-core";
import { writeOp } from "seedkernel-wasm/op-frame";
import { verifyBundle, genesisHash } from "seedkernel-wasm/bundle";
import { WsNetwork } from "seedkernel-wasm/net-ws";

import { APP_OP_CONTEXT, APP_OP_UI, MAX_QUEUED_RENDERS, admitGate, appFacts, bundleDigest, toHex, fromHex } from "../browser/app-api.js";
import { Peers } from "../browser/peers.js";
// How one shell talks to another, whichever kind each is: the boot bundle the page pins,
// pinned here the same way. This node says what it is called, and hears what others are.
import { SHELL_PROTO, SHELL_OP_TELL } from "../browser/shell-app.js";
import { shellBundleBytes, SHELL_AUTHOR_HEX, SHELL_APP } from "../browser/shell-bundle.js";

export { toHex, fromHex };

/** The door a view is given, which a head is given too. */
const VIEW_LIB = join(dirname(fileURLToPath(import.meta.url)), "../assembly/view-lib/app.js");

/** Run a node that hosts the app in `bundle` (a .skb's bytes), with `head` in front of it:
 *  the paths of its scripts, in order, and `grants`, what they are handed beside the door.
 *  The node is `identity` and calls itself `nick`. It registers on `relay`
 *  (`ws[s]://host[:port]`, with `relaySecret` for a private one) and stays in `rooms` there.
 *  `say` is told what a person watching would want to know. Answers the node's key in hex,
 *  and `close`. */
export async function hostApp({ sodium, identity, nick = "", relay, relaySecret = null, rooms, bundle, head, grants = {}, say = console.log }) {
  const digest = (bytes) => genesisHash(sodium, bytes);
  const short = (key) => key.slice(0, 8);

  // Nothing of the transport's word is acted on until the app stands, and the relay's state
  // is not said while the first join is under way, which reads as a relay that dropped.
  let standing = false;
  let joining = true;
  const sayRelay = () => say(peers.relayState === 1 ? `on the relay at ${relay}` : peers.relayState === 2 ? `the relay at ${relay} is unreachable; retrying` : "on no relay");
  // A nick is printed without control characters, which a terminal acts on.
  const label = (key) => {
    const called = ((key === peers.me ? peers.nick : peers.nicks.get(key)) ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    return called ? `${called} (${short(key)})` : short(key);
  };

  // The relay's state and the linked peers (seedkernel §12.6): every link of this node's
  // is relayed, so how each is reached is not said.
  function onStatus(status) {
    const relayWas = peers.relayState, linkedWas = [...peers.linked.keys()];
    peers.status(status);
    if (!standing) return;
    if (peers.relayState !== relayWas && !joining) sayRelay();
    for (const key of peers.linked.keys()) if (!linkedWas.includes(key)) say(`linked to ${label(key)}`);
    for (const key of linkedWas) if (!peers.linked.has(key)) say(`${label(key)} is gone`);
  }

  // The consent gate is the page's (`admitGate`): the shell app by its pin, and the one app
  // whoever runs this node named.
  const consents = new Set();
  const { shell } = await bootShell({
    sodium, identity,
    // A room keeps its members linked, so links do not idle out (shell.js).
    transport: { channels: new WsNetwork(), onStatus: (s) => onStatus(s), config: { linkIdleTimeoutMs: 0 } },
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

  // What a peer's shell tells this one about itself rides shell/v1: its nick is kept, and
  // that it made this node a contact is not this node's business. A call's signals and an
  // offer, which ride the same app's other claims, are for a node that can hold one.
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

  // The head's `window`: its parent is this shell, and what this shell says reaches the
  // listener view-lib/app.js adds, as from that parent.
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
  /** Hand the head what its guest answered, to a peer's frame or to the context. One that
   *  comes before the head is ready is held, but for a context, which it is told afresh. */
  function render(payload, isContext = false) {
    if (payload.length === 0) return;
    if (ready) { toHead({ type: "render", payload }); return; }
    if (isContext) return;
    queued.push(payload);
    if (queued.length > MAX_QUEUED_RENDERS) queued.shift();
  }

  /** Tell the guest the context if it has changed, and hand the head its answer. */
  let told = null;
  async function tellContext() {
    const json = peers.context();
    if (!ready || json === told) return;
    told = json;
    try { render(await guest.invoke(writeOp(APP_OP_CONTEXT, new TextEncoder().encode(json))), true); }
    catch (err) { say(`${facts.name}: ${err.message}`); }
  }

  /** What the head says, as the page hears a view (shell.js): `ready`, and `call`, bytes for
   *  its guest, answered under the id it gave. A node with no contacts and no calls has
   *  nothing to do with a `conv` or a `contact`. */
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

  // The head's scripts share one scope, which is this process's, as a page's share the
  // page's: so a node runs one head.
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
