// The shell with no page: a node that hosts one app from a console, as browser/shell.js
// hosts several from a tab. It owns what that shell owns, less what only a person at a page
// has a use for: this node's identity and nick, the relay, its rooms and who is in them,
// and the links to them. It has no contacts, takes no offers and holds no calls.
//
// The app is a signed bundle like any other, admitted because whoever started this node
// named it, which is what dropping its file on the page says. Its guest is driven through
// the same two ops (browser/app-api.js). What stands where a view would is a HEAD: plain
// script this shell runs in the order given, as a page runs a view's, with the door a
// view is given by assembly/view-lib/app.js in front of it, by the same names:
//
//   app.ready()                    the head is listening: the node's context comes first,
//                                  then what arrived while it loaded
//   app.call(...parts)             bytes for the app's guest, and a promise of its answer
//   app.onRender(fn)               fn(bytes): what the guest answered a peer's frame
//   app.onContext(fn)              fn(ctx): the node's context
//   app.cast(room, ...parts)       with the room pipe: a frame to every linked member
//   app.tell(room, to, ...parts)   with the room pipe: a frame to one member
//   app.onFrame(fn)                with the room pipe: fn(from, room, body), a peer's frame
//   toHex, fromHex, concat         bytes as hex, and end to end
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
import { runInThisContext } from "node:vm";

import { bootShell } from "seedkernel-wasm/shell-core";
import { writeOp, OpArgs } from "seedkernel-wasm/op-frame";
import { verifyBundle, genesisHash } from "seedkernel-wasm/bundle";
import { WsNetwork } from "seedkernel-wasm/net-ws";
import { roomClient, roomId } from "seedrelay/rooms";

import { APP_OP_CONTEXT, APP_OP_UI, NET_PROTO, admitGate, appFacts, bundleDigest, contextJson } from "../browser/app-api.js";
// How one shell talks to another, whichever kind each is: the boot bundle the page pins,
// pinned here the same way. This node says what it is called, and answers a page's call.
import { SHELL_PROTO, SHELL_OP_TELL } from "../browser/shell-app.js";
import { shellBundleBytes, SHELL_AUTHOR_HEX, SHELL_APP } from "../browser/shell-bundle.js";

export const toHex = (bytes) => Buffer.from(bytes).toString("hex");
export const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
/** The parts end to end, in a buffer of its own. A part is bytes, or an array of them. */
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** What guest-lib speaks to whatever is in front of a guest, as assembly/view-lib/app.js
 *  spells it for a view: the context and a peer's frame as renders (context.js,
 *  room-pipe.js), and the pipe's two asks. */
const RENDER_CONTEXT = 0, RENDER_FRAME = 1;
const ASK_CAST = 1, ASK_TELL = 2;

/** Renders held for a head that has not said it is ready; past this the oldest go. */
const MAX_QUEUED_RENDERS = 512;
/** The longest nick kept, a peer's or this node's. */
const MAX_NICK = 32;
/** What a call presents to a room-mate, which asks no contact secret of one: 32 zero bytes. */
const NO_SECRET = new Uint8Array(32);

/** Run a node that hosts the app in `bundle` (a .skb's bytes), with `head` in front of it:
 *  the paths of its scripts, in order, and `grants`, what they are handed beside the door.
 *  The node is `identity` and calls itself `nick`. It registers on `relay`
 *  (`ws[s]://host[:port]`, with `relaySecret` for a private one) and stays in `rooms` there.
 *  `say` is told what a person watching would want to know. Answers the node's key in hex,
 *  and `close`. */
export async function hostApp({ sodium, identity, nick = "", relay, relaySecret = null, rooms, bundle, head, grants = {}, say = console.log }) {
  const me = toHex(identity.publicKey);
  const myNick = nick.trim().slice(0, MAX_NICK);
  const digest = (bytes) => genesisHash(sodium, bytes);
  const short = (key) => key.slice(0, 8);

  // The transport's word for its relay, and the peers it is linked to, as last told
  // (`onStatus`): nothing of it is acted on until the app stands, and the relay's state is
  // not said while the first join is under way, which reads as a relay that dropped.
  let relayNow = 0;
  let linkedNow = [];
  let standing = false;
  let joining = true;
  const sayRelay = () => say(relayNow === 1 ? `on the relay at ${relay}` : relayNow === 2 ? `the relay at ${relay} is unreachable; retrying` : "on no relay");
  // The rooms this node is in, by name: `id` is the room's id on the relay, in hex, and
  // `members` the keys the room client last heard are in it.
  const joined = new Map();
  for (const name of rooms) joined.set(name, { id: await roomId(name), members: new Set() });
  // Everyone this node wants a link to, by key in hex: its room-mates, each with how the
  // call to it stands.
  const wanted = new Map();
  // What each peer calls itself, and the linked peers whose shell has heard this node's nick.
  const peerNicks = new Map();
  const nickTold = new Set();
  // A nick is printed without control characters, which a terminal acts on.
  const label = (key) => {
    const called = ((key === me ? myNick : peerNicks.get(key)) ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    return called ? `${called} (${short(key)})` : short(key);
  };

  // One relay state, then `[key 32][direct u8]` for each linked peer (seedkernel §12.6).
  function onStatus(status) {
    const relayWas = relayNow, linkedWas = linkedNow;
    relayNow = status[0];
    linkedNow = [];
    for (let off = 1; off + 33 <= status.length; off += 33) linkedNow.push(toHex(status.subarray(off, off + 32)));
    if (!standing) return;
    if (relayNow !== relayWas && !joining) sayRelay();
    for (const key of linkedNow) if (!linkedWas.includes(key)) say(`linked to ${label(key)}`);
    for (const key of linkedWas) if (!linkedNow.includes(key)) say(`${label(key)} is gone`);
    follow();
  }

  // The consent gate is the page's (`admitGate`): the shell app by its pin, and the one app
  // whoever runs this node named.
  const consents = new Set();
  const { shell } = await bootShell({
    sodium, identity,
    // A room keeps its members linked, so links do not idle out (shell.js).
    transport: { channels: new WsNetwork(), onStatus, config: { linkIdleTimeoutMs: 0 } },
    admit: admitGate([{ author: SHELL_AUTHOR_HEX, app: SHELL_APP }], consents, digest),
  });

  /** One op of the transport's (seedkernel §12.10). There is nothing to do about one it
   *  refuses. */
  const netOp = (op) => shell.call(NET_PROTO, op.build())?.catch(() => {}) ?? Promise.resolve();

  // What a peer's shell tells this one about itself rides shell/v1: its nick is kept, and
  // that it made this node a contact is not this node's business. A call's signals, which
  // ride the same app's other claim, are for a node that can hold one.
  const shellApp = await shell.install(shellBundleBytes(), {
    onInbound: (claim, from, answer) => {
      if (claim !== SHELL_PROTO || answer.length === 0) return;
      let said;
      try { said = JSON.parse(new TextDecoder().decode(answer)); } catch { return; }
      if (typeof said?.nick !== "string") return;
      const key = toHex(from);
      if (said.nick) peerNicks.set(key, said.nick.slice(0, MAX_NICK)); else peerNicks.delete(key);
      void tellContext();
    },
  });
  /** Tell a peer's shell something, under shell/v1: whether it got it. The transport dials
   *  a peer it is sent to and has an address for, so this is also how a peer is called. */
  const tellShell = async (key, notice) =>
    (await shellApp.invoke(writeOp(SHELL_OP_TELL, concat(fromHex(key), notice))))[0] === 1;

  // ── the app, and the door its head has to it ──────────────────────────────
  const heard = { render: null, context: null, frame: null };
  let ready = false;
  const queued = [];
  const verified = verifyBundle(sodium, bundle);
  const facts = appFacts(verified.manifest);
  consents.add(toHex(bundleDigest(verified, digest)));
  const guest = await shell.install(bundle, { onInbound: (claim, from, answer) => render(new Uint8Array(answer)) });

  /** Hand the head what its guest answered, to a peer's frame or to the context. One that
   *  comes before the head is ready is held, but for a context, which it is told afresh. */
  function render(p) {
    if (p.length === 0) return;
    if (!ready) {
      if (p[0] !== RENDER_CONTEXT) queued.push(p);
      if (queued.length > MAX_QUEUED_RENDERS) queued.shift();
      return;
    }
    try {
      if (p[0] === RENDER_CONTEXT && heard.context) heard.context(JSON.parse(new TextDecoder().decode(p.subarray(1))));
      else if (p[0] === RENDER_FRAME && p.length >= 65 && heard.frame) heard.frame(toHex(p.subarray(1, 33)), toHex(p.subarray(33, 65)), p.subarray(65));
      else if (heard.render) heard.render(p);
    } catch (err) { say(`${facts.name}'s head: ${err.stack ?? err}`); }
  }
  const call = (...parts) => guest.invoke(writeOp(APP_OP_UI, concat(...parts)));
  /** A cast or a tell is answered with nothing, so one that failed is only said. */
  const send = (...parts) => { call(...parts).catch((err) => say(`${facts.name}: ${err.message}`)); };

  /** The node's context, as the page tells it to its apps (shell.js `contextNow`). */
  const contextNow = () => contextJson({
    me, nick: myNick,
    rooms: [...joined].map(([name, r]) => ({ id: r.id, name, members: [...r.members].sort() })),
    linked: [...linkedNow].sort(),
    contacts: [],
    nicks: Object.fromEntries([...peerNicks].sort(([a], [b]) => (a < b ? -1 : 1))),
  });
  /** Tell the guest the context if it has changed, and hand the head its answer. */
  let told = null;
  async function tellContext() {
    const json = contextNow();
    if (!ready || json === told) return;
    told = json;
    try { render(await guest.invoke(writeOp(APP_OP_CONTEXT, new TextEncoder().encode(json)))); }
    catch (err) { say(`${facts.name}: ${err.message}`); }
  }

  const app = {
    ready: () => {
      ready = true;
      void tellContext().then(() => { for (const p of queued.splice(0)) render(p); });
    },
    call,
    onRender: (fn) => { heard.render = fn; },
    onContext: (fn) => { heard.context = fn; },
    cast: (room, ...parts) => send([ASK_CAST], fromHex(room), ...parts),
    tell: (room, to, ...parts) => send([ASK_TELL], fromHex(to), fromHex(room), ...parts),
    onFrame: (fn) => { heard.frame = fn; },
  };
  // The head's scripts share one scope, which is this process's, as a page's share the
  // page's: so a node runs one head.
  Object.assign(globalThis, { app, toHex, fromHex, concat, ...grants });
  for (const path of head) runInThisContext(readFileSync(path, "utf8"), { filename: path });

  // ── the relay, its rooms, and the links to who is in them ─────────────────
  /** Call `key`, a room-mate this node has no link to: tell its shell nothing, which has
   *  the transport dial it and says whether anyone answered. One that gives no answer is
   *  left alone until it calls, or is heard joining a room again. */
  async function callPeer(key, w) {
    w.calling = true;
    const answered = await tellShell(key, new Uint8Array(0)).catch(() => false);
    w.calling = false;
    if (!answered && !linkedNow.includes(key)) w.silent = true;
  }

  /** Run when the links or the relay's state change, and when who this node wants linked
   *  does: call whoever is wanted and not linked, tell each linked peer this node's nick
   *  once, and tell the app who is linked now. */
  function follow() {
    for (const [key, w] of wanted) {
      if (linkedNow.includes(key)) w.silent = false;
      else if (relayNow === 1 && !w.silent && !w.calling) void callPeer(key, w);
    }
    for (const key of [...nickTold]) if (!linkedNow.includes(key)) nickTold.delete(key);
    const notice = new TextEncoder().encode(JSON.stringify({ nick: myNick }));
    for (const key of linkedNow) {
      if (nickTold.has(key)) continue;
      nickTold.add(key);
      void tellShell(key, notice).catch(() => false).then((got) => { if (!got) nickTold.delete(key); });
    }
    void tellContext();
  }

  /** Give the transport its address for `key`: the relay to call it through, or none for
   *  one this node no longer wants linked. */
  const teach = (key) => netOp(new OpArgs("addr").blob(fromHex(key)).blob(NO_SECRET).text(wanted.has(key) ? `relay+${relay}` : ""));

  // A key the room client heard join or leave a room. One that joins is called afresh.
  function onMember(room, key, present) {
    const r = joined.get(room);
    if (!r || key === me) return;
    if (present) { r.members.add(key); wanted.delete(key); }
    else r.members.delete(key);
    const mates = new Set();
    for (const { members } of joined.values()) for (const k of members) mates.add(k);
    for (const k of [...wanted.keys()]) {
      if (mates.has(k)) continue;
      wanted.delete(k);
      void teach(k);
    }
    for (const k of mates) {
      if (!wanted.has(k)) wanted.set(k, { silent: false, calling: false });
      void teach(k);
    }
    follow();
  }

  standing = true;
  say(`${[facts.name, facts.version].filter(Boolean).join(" ")} is ${label(me)}`);
  const client = roomClient({
    relay,
    publicKey: identity.publicKey,
    sign: (m) => sodium.crypto_sign_detached(m, identity.privateKey),
    ...(relaySecret ? { secret: relaySecret, blake2b: (m) => sodium.crypto_generichash(64, m) } : {}),
    onMember,
    onRefused: (name) => say(`the room ${name} is full`),
  });
  const op = new OpArgs("relay").text(relay);
  if (relaySecret) op.text(relaySecret);
  await netOp(op);
  joining = false;
  sayRelay();
  for (const name of joined.keys()) await client.join(name);

  return {
    key: me,
    close() {
      client.close();
      shell.close();
    },
  };
}
