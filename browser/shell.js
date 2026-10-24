// The browser shell. Every seedkernel import is a published entry point of seedkernel-wasm
// (its package.json "exports"), resolved by the import map in shell.html to the vendored
// build, so a seedkernel change can only break the shell through its public API.
//
// The host (§12.9) runs on the browser platform using the host blob's realm engine and
// crypto; nothing is eval'd, so the CSP needs no 'unsafe-eval'. `standUp` assembles the node
// and pins the transport bundle itself, so the page's `admit` is only its consent gate.
import { browserPlatform } from "seedkernel-wasm/platform-web";
import { platformHost } from "seedkernel-wasm/platform";
import { hostBlob } from "./host-blob.js";
import { writeOp, OpArgs } from "seedkernel-wasm/op-frame";
import { verifyBundle, genesisHash } from "seedkernel-wasm/bundle";
// Sockets: a WebSocket for the relay, and WebRTC for the direct links the transport moves to.
import { WsNetwork } from "seedkernel-wasm/net-ws";
import { RtcNetwork } from "seedkernel-wasm/net-rtc";
import { combineChannels } from "seedkernel-wasm/socket-seam";
import { Peers, ROOM_NAME_RE, friendlyRoom } from "./peers.js";
import { roomId } from "seedrelay/rooms";
import { MediaCalls } from "./media-rtc.js";
import { APP_GRANTS, APP_OP_CONTEXT, APP_OP_UI, MAX_QUEUED_RENDERS, admitGate, appFacts, bundleDigest, toHex, fromHex } from "./app-api.js";
import { guardView } from "./view-guard.js";
import { CALL_PROTO, OFFER_PROTO, SHELL_OP_TELL, SHELL_OP_SIGNAL, SHELL_OP_OFFER } from "./shell-app.js";
import { shellBundleBytes, SHELL_AUTHOR_HEX, SHELL_APP } from "./shell-bundle.js";

const shellLog = document.getElementById("shell-log");
const relayUrlInput = document.getElementById("relay-url");
const relayRoomInput = document.getElementById("relay-room");
const relaySecretInput = document.getElementById("relay-secret");
const relayConnectBtn = document.getElementById("connect-relay");
const roomJoinBtn = document.getElementById("join-room");
const relayNewRoomBtn = document.getElementById("new-room");
const roomListEl = document.getElementById("room-list");
const contactAddInput = document.getElementById("add-contact");
const contactAddSecretInput = document.getElementById("add-contact-secret");
const contactAddBtn = document.getElementById("add-contact-btn");
const contactInput = document.getElementById("contact-secret");
const contactSetBtn = document.getElementById("set-contact");
const contactNewBtn = document.getElementById("new-contact");
const contactCopyBtn = document.getElementById("copy-contact");
const contactHint = document.getElementById("contact-hint");
const nickInput = document.getElementById("nick");
const nickSetBtn = document.getElementById("set-nick");
const relayStatus = document.getElementById("relay-status");
const peerListEl = document.getElementById("peer-list");
const appStatus = document.getElementById("app-status");
const appPanel = document.getElementById("panel-app");
const diagnostics = appPanel.querySelector("details.diagnostics");
const appEmpty = document.getElementById("app-empty");
const aboutBtn = document.getElementById("about-toggle");
const aboutPanel = document.getElementById("about");
const dropzone = document.getElementById("dropzone");
const appFileInput = document.getElementById("app-file");
const appListEl = document.getElementById("app-list");
const offerListEl = document.getElementById("offer-list");
const offersSection = document.getElementById("offers-section");
const openAppsBtn = document.getElementById("open-apps-btn");
const appsNotice = document.getElementById("apps-notice");
let appsNoticeTimer = null;

// Show a message on the Apps panel (and switch to it). Diagnostics gets the full text too.
function showAppsNotice(text, kind = "err") {
  appsNotice.textContent = text;
  appsNotice.classList.remove("err", "ok");
  if (kind === "err" || kind === "ok") appsNotice.classList.add(kind);
  appsNotice.hidden = false;
  if (appsNoticeTimer) clearTimeout(appsNoticeTimer);
  appsNoticeTimer = setTimeout(() => { appsNotice.hidden = true; }, 6000);
  showTab("apps");
}

// top-bar status elements
const relayPill = document.getElementById("relay-pill");
const relayPillText = document.getElementById("relay-pill-text");
const peerPill = document.getElementById("peer-pill");
const peerPillText = document.getElementById("peer-pill-text");
const identityPill = document.getElementById("identity-pill");

const tabs = {
  relay:  { btn: document.getElementById("tab-relay"),  panel: document.getElementById("panel-relay")  },
  apps:   { btn: document.getElementById("tab-apps"),   panel: document.getElementById("panel-apps")   },
  app:    { btn: document.getElementById("tab-app"),    panel: document.getElementById("panel-app")    },
};
function showTab(name) {
  for (const [k, t] of Object.entries(tabs)) {
    t.btn.classList.toggle("active", k === name);
    t.panel.classList.toggle("hidden", k !== name);
  }
  // Clear the tab's unread dot.
  tabs[name].btn.classList.remove("unread");
}
for (const [k, t] of Object.entries(tabs)) {
  t.btn.addEventListener("click", () => showTab(k));
}

aboutBtn.addEventListener("click", () => {
  aboutPanel.classList.toggle("open");
  aboutPanel.hidden = !aboutPanel.classList.contains("open");
});

/** Cap on Diagnostics lines, so a failing view or a noisy peer can't grow the page forever. */
const MAX_LOG_LINES = 500;

function shellPrint(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  shellLog.appendChild(line);
  while (shellLog.childElementCount > MAX_LOG_LINES) shellLog.firstElementChild.remove();
  shellLog.scrollTop = shellLog.scrollHeight;
}

/** 32 bytes as lowercase hex (a key or contact secret). */
const HEX32_RE = /^[0-9a-f]{64}$/;

/** Run `act` on Enter in `field`. */
function onEnter(field, act) {
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); act(); }
  });
}

/** Parse `field` as 32 bytes of hex: the bytes, null if empty, or undefined if invalid (in
 *  which case the field is marked invalid with message `why`, cleared on input). */
function readHex32(field, why) {
  const typed = field.value.trim().toLowerCase();
  if (typed === "") return null;
  if (HEX32_RE.test(typed)) return fromHex(typed);
  field.setCustomValidity(why);
  field.reportValidity();
  return undefined;
}

/** Set up a hex-input field: clear its error on input, run `act` on Enter. */
function hexField(field, act) {
  field.addEventListener("input", () => field.setCustomValidity(""));
  onEnter(field, act);
}

/** A small list-row button. */
function iconButton(label, onClick, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon";
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

shellPrint("Starting the shell...", "sys");
// The host blob holds the realm engine and the crypto (libsodium, ML-DSA-65). Its `sodium`
// is ready before anything below needs it; verifyBundle is synchronous. The browser only
// verifies bundles; signing is offline (seedkernel-wasm/bundle-author).
const host = platformHost(browserPlatform({ hostBlob: await hostBlob }));
const sodium = host.sodium;

// Digests (`bundleDigest`) of bundles the user has just consented to. `admit` consumes one
// per install. Consent, not an author allow-list, is this shell's gate.
const pendingApprovals = new Set();
/** seedkernel's BLAKE2b-256 hash. */
const digest = (bytes) => genesisHash(sodium, bytes);
// Contact notices still to send, key hex → true (added) / false (removed). Sent once the
// peer is linked (`tellPeers`).
const untoldPeers = new Map();

// ─── per-tab Ed25519 identity ──────────────────────────────────────────
let myKeys;
// FIXME: this is just a demo
const stored = sessionStorage.getItem("shell.identity");
if (stored) {
  const parsed = JSON.parse(stored);
  myKeys = {
    publicKey:  new Uint8Array(parsed.pk),
    privateKey: new Uint8Array(parsed.sk),
  };
} else {
  const kp = sodium.crypto_sign_keypair();
  myKeys = { publicKey: kp.publicKey, privateKey: kp.privateKey };
  sessionStorage.setItem("shell.identity", JSON.stringify({
    pk: Array.from(kp.publicKey),
    sk: Array.from(kp.privateKey),
  }));
}
const myPkHex = toHex(myKeys.publicKey);

shellPrint(`I am ${myPkHex.slice(0, 8)}`, "sys");

// ─── the contact secret ────────────────────────────────────────────────
// This node's contact secret (see peers.js), or null.
const savedContact = sessionStorage.getItem("shell.contactSecret");
let myContactSecret = savedContact && HEX32_RE.test(savedContact) ? fromHex(savedContact) : null;

// The sockets the transport drives: the relay WebSocket and WebRTC data channels.
const net = combineChannels(new WsNetwork(), new RtcNetwork());

// Assemble the node (§12.8, §12.9). The platform supplies crypto, realm engine, workers and
// an in-memory store; the page supplies its identity, the sockets and the admit gate.
// `standUp` builds the transport from `transport` and ignores fields it doesn't know.
//
// `admit` pins the shell boot bundle by author and app, and otherwise requires a consent
// (`admitGate`). The transport bundle never goes through it.
const { shell } = await host.standUp({
  dir: "shell",
  identity: myKeys,
  // Never idle out links: rooms keep members linked, and peers.js redials dropped ones.
  transport: {
    channels: net,
    onStatus: (status) => onStatus(status),
    config: { linkIdleTimeoutMs: 0, ...(myContactSecret ? { contactSecret: toHex(myContactSecret) } : {}) },
  },
  // The shell app's author and app come from the generated browser/shell-bundle.js.
  admit: admitGate([{ author: SHELL_AUTHOR_HEX, app: SHELL_APP }], pendingApprovals, digest),
});

// Peer state (peers.js). The UI redraws on `changed` (`followPeers`) and `onRooms`.
const peers = new Peers({
  shell, identity: myKeys, sodium,
  tell: tellPage,
  changed: () => followPeers(),
  onRooms: (renamed) => {
    if (renamed) sessionStorage.setItem("shell.rooms", JSON.stringify([...peers.rooms.keys()]));
    renderRoomList();
  },
  onRefused: (name) => shellPrint(`Room ${friendlyRoom(name)} is full; try again later.`, "err"),
});
peers.setNick(sessionStorage.getItem("shell.nick") ?? "");
try {
  for (const [key, secret] of Object.entries(JSON.parse(sessionStorage.getItem("shell.contacts") ?? "{}"))) {
    if (HEX32_RE.test(key)) peers.contacts.set(key, HEX32_RE.test(secret) ? fromHex(secret) : null);
  }
} catch {}

function saveContacts() {
  sessionStorage.setItem("shell.contacts",
    JSON.stringify(Object.fromEntries([...peers.contacts].map(([k, s]) => [k, s ? toHex(s) : ""]))));
}

// ─── boot the shell app ─────────────────────────────────────────────────
// Shell-to-shell messages (shell-app.js). Incoming frames arrive via `onInbound`, routed by
// the claim they came in under; outgoing ones go through the app's ops, since only a guest
// can reach `_net`.
const shellApp = await shell.install(shellBundleBytes(), {
  onInbound: (claim, from, answer) => {
    if (answer.length === 0) return;
    if (claim === CALL_PROTO) void media.onSignal(toHex(from), answer);
    else if (claim === OFFER_PROTO) handleOffer(answer, toHex(from));
    else onPageNotice(toHex(from), answer);
  },
});

/** Send `bytes` to a peer's shell using one of the shell app's ops. */
function sendPage(op, peerId, bytes) {
  const arg = new Uint8Array(32 + bytes.length);
  arg.set(fromHex(peerId), 0);
  arg.set(bytes, 32);
  return shellApp.invoke(writeOp(op, arg));
}

/** Send a shell/v1 notice; resolves to whether the peer's shell got it. */
async function tellPage(peerId, notice) {
  return (await sendPage(SHELL_OP_TELL, peerId, notice))[0] === 1;
}

/** Handle a shell/v1 notice from `from`. Contact adds and removals are mirrored, so both
 *  ends agree on being peers. */
function onPageNotice(from, bytes) {
  let msg;
  try { msg = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  if (typeof msg?.nick === "string") {
    peers.heardNick(from, msg.nick);
    renderRoomList();
    followPeers();
    return;
  }
  if (typeof msg?.peer !== "boolean") return;
  if (msg.peer && !peers.contacts.has(from)) {
    addContact(from, null, { tell: false });
    shellPrint(`${peers.label(from)} added you as a peer.`, "sys");
  } else if (!msg.peer && peers.contacts.has(from)) {
    removeContact(from, { tell: false });
    shellPrint(`${peers.label(from)} removed you as a peer.`, "sys");
  }
}

const media = new MediaCalls({
  myId: myPkHex,
  // Use the transport's STUN for this peer, so no third party learns who is calling.
  iceServers: (peerId) => peers.ice(peerId),
  send: (peerId, signal) => sendPage(SHELL_OP_SIGNAL, peerId, signal),
  onCallers: () => callersChanged(),
  onPeerClosed: (peerId) => {
    removeRemoteTile(peerId);
    updateCallStatus();
  },
  onTrack: (peerId, track) => {
    const tile = getOrCreateRemoteTile(peerId);
    // A track the peer turned off and on again is announced again; ignore the repeat.
    if (tile.stream.getTracks().includes(track)) return;
    tile.stream.addTrack(track);
    const draw = () => drawTile(tile.wrap, tile.stream);
    track.addEventListener("mute", draw);
    track.addEventListener("unmute", draw);
    track.addEventListener("ended", () => {
      try { tile.stream.removeTrack(track); } catch {}
      if (tile.stream.getTracks().length === 0) removeRemoteTile(peerId);
      else draw();
    });
    draw();
  },
});

// Peer identity is the transport's job: each channel runs a HELLO/AUTH handshake (§12.6),
// so every frame arrives attributed to an authenticated key. No per-message signatures.

// ─── top-bar status updates ───────────────────────────────────────────
identityPill.textContent = `id ${myPkHex.slice(0, 8)}`;
identityPill.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(myPkHex);
    const prev = identityPill.textContent;
    identityPill.textContent = "copied!";
    setTimeout(() => { identityPill.textContent = prev; }, 1100);
  } catch {}
});

function setRelayPill(state, label) {
  // state: "off" | "connecting" | "ok" | "err"
  relayPill.classList.remove("ok", "warn", "err");
  if (state === "ok")           relayPill.classList.add("ok");
  else if (state === "connecting") relayPill.classList.add("warn");
  else if (state === "err")     relayPill.classList.add("err");
  relayPillText.textContent = label;
}

// Transport status: relay state and linked peers, pushed on every change.
function onStatus(status) {
  peers.status(status);
  showRelay();
}

// Peer pill: linked count, and how many are relayed (green when all are direct).
function updatePeerPill() {
  const open = peers.linked.size;
  const relayed = [...peers.linked.values()].filter((direct) => !direct).length;
  peerPillText.textContent = (open === 1 ? "1 peer" : `${open} peers`) + (relayed > 0 ? ` · ${relayed} via relay` : "");
  peerPill.classList.toggle("ok", open > 0 && relayed === 0);
  peerPill.classList.toggle("warn", relayed > 0);
  peerPill.title = open === 0 ? "Connected peers"
    : relayed === 0 ? "Connected peers — all linked directly"
    : `Connected peers — ${open - relayed} direct, ${relayed} through the relay`;
}

// The Network tab's peer list: every contact, plus linked peers that share no room with us
// (they called us directly). Room-mates appear under their room instead. An unlinked
// contact shows a secret field and Connect. Rows are updated in place, never rebuilt, so a
// half-typed field survives a redraw.
const PEER_STATES = {
  direct: ["direct", "Linked peer to peer over WebRTC; the relay carries none of this traffic."],
  relayed: ["via relay", "The relay forwards this link's encrypted bytes; no direct link has been made."],
  calling: ["connecting…", "Calling this peer through the relay."],
  silent: ["no answer", "This peer did not answer. It may be offline, or have a contact secret this node did not present."],
};
const peerRows = new Map(); // key hex to { li, name, secret, connect, remove, state, shown }
const peerListEmpty = peerListEl.querySelector(".empty-row");

function buildPeerRow(id) {
  const li = document.createElement("li");
  li.className = "peer-row";
  const name = document.createElement("span");
  name.className = "peer-row-id peer-row-name";
  name.title = id;
  const secret = document.createElement("input");
  secret.type = "password";
  secret.className = "peer-secret";
  secret.placeholder = "contact secret, if it has one";
  secret.autocomplete = "off";
  secret.spellcheck = false;
  secret.setAttribute("aria-label", `Contact secret of ${id.slice(0, 8)}`);
  const connect = iconButton("Connect", () => connectPeer(id, secret));
  const remove = iconButton("Remove peer", () => removeContact(id), "Stop being a contact: the link goes unless you share a room.");
  const state = document.createElement("span");
  hexField(secret, () => connectPeer(id, secret));
  secret.hidden = connect.hidden = remove.hidden = true;
  li.append(name, secret, connect, remove, state);
  return { li, name, secret, connect, remove, state, shown: "" };
}

function renderPeerList() {
  const { linked, wanted, contacts } = peers;
  const ids = [...new Set([...linked.keys(), ...wanted.keys()])]
    .filter((id) => contacts.has(id) || (linked.has(id) && peers.roomsOf(id).length === 0))
    .sort();
  for (const [id, row] of peerRows) {
    if (!ids.includes(id)) { row.li.remove(); peerRows.delete(id); }
  }
  peerListEmpty.hidden = ids.length > 0;
  ids.forEach((id, i) => {
    let row = peerRows.get(id);
    if (!row) peerRows.set(id, row = buildPeerRow(id));
    // Keep key order after the empty row; don't move rows already in place (keeps focus).
    if (peerListEl.children[i + 1] !== row.li) peerListEl.insertBefore(row.li, peerListEl.children[i + 1] ?? null);
    const isLinked = linked.has(id), isContact = contacts.has(id);
    const label = peers.label(id);
    const state = isLinked ? (linked.get(id) ? "direct" : "relayed") : wanted.get(id).silent ? "silent" : "calling";
    const shown = `${state} ${isContact} ${label}`;
    if (shown === row.shown) return;
    // Refill the secret field whenever it becomes visible.
    const asks = isContact && !isLinked;
    if (asks && row.secret.hidden) row.secret.value = contacts.get(id) ? toHex(contacts.get(id)) : "";
    row.secret.hidden = row.connect.hidden = !asks;
    row.name.textContent = label;
    row.remove.hidden = !isContact;
    row.shown = shown;
    row.state.className = `peer-route ${state}`;
    [row.state.textContent, row.state.title] = PEER_STATES[state];
  });
}

// ─── app registry ──────────────────────────────────────────────────────
//
// An app is a signed bundle (§12.4), the same format seedstore loads. `shell.install`
// verifies the author's signatures over the whole body, so a bundle can be forwarded by any
// number of peers and still authenticate against its original author; we never re-sign.
//
// The shell reads only the signed manifest (`appFacts`). The manifest's `app` label is the
// install slot: one app per label per node, whatever its author. Labels are node-local, so
// two peers can run different authors' apps as long as both speak the same protocol.
//
// installedApps: label → AppRecord (the guest handle, the view, and the signed bundle bytes
// that "Offer" sends).
const installedApps = new Map();   // app label → AppRecord
// Label of the app whose view is in front, or null. All installed apps keep running.
let activeAppKey = null;

// There is no routing table: installing a bundle routes the protocols its manifest claims
// to it (§12.10). Each claim has one holder.

const STORE = "apps.v3";

// ── an app's guest ──────────────────────────────────────────────────────
// The shell only ever calls a guest's two ops, `ctx` and `ui` (app-api.js). Peer frames
// reach the guest directly under its claimed protocols, never through the shell.

/** Call op `op` on `rec`'s guest. */
function invokeApp(rec, op, bytes) {
  return rec.invoke(writeOp(op, bytes));
}

/** Send the current context to `rec`'s guest; resolves to its answer (render bytes, or
 *  empty on failure). */
async function tellContext(rec) {
  // Marked as sent up front so concurrent `postContext` calls don't repeat it.
  const json = rec.ctx = peers.context();
  try { return await invokeApp(rec, APP_OP_CONTEXT, new TextEncoder().encode(json)); }
  catch (err) {
    shellPrint(`${rec.name}: ${err.message}`, "err");
    // Not delivered: forget it, so the next `postContext` tries again.
    if (rec.ctx === json) rec.ctx = null;
    return new Uint8Array(0);
  }
}

/** Send the context to every app whose guest hasn't seen this version of it, and forward
 *  the answers to the views. Cheap to call often: unchanged context is skipped. */
function postContext() {
  const json = peers.context();
  for (const rec of installedApps.values()) {
    if (rec.ctx !== json) void tellContext(rec).then((answer) => deliverRender(rec, answer, { isContext: true }));
  }
}

// ── an app's view ───────────────────────────────────────────────────────
//
// Each app's view is its HTML page in a sandboxed iframe loaded from a blob: URL, created at
// install and kept until removal. Hidden views keep receiving renders, so they're current
// when shown. The sandbox keeps a view away from this page; `guardView` (view-guard.js)
// keeps it off the network, so data a view sees can only leave through its guest.
//
// allow-forms lets views use <form> (they preventDefault on submit). allow-downloads lets a
// view hand the user a file from a blob it made (jam saves tracks that way).

function mountView(rec) {
  if (!rec.ui) return;
  // shell.html's `frame-src blob:` is what stops a view navigating itself to a server
  // (guardView's frame-src only covers frames the view creates). Keep it.
  const frame = document.createElement("iframe");
  frame.className = "app-frame hidden";
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads");
  frame.title = `${rec.name} UI`;
  rec.blobUrl = URL.createObjectURL(new Blob([guardView(rec.ui)], { type: "text/html;charset=utf-8" }));
  frame.src = rec.blobUrl;
  appPanel.insertBefore(frame, diagnostics);
  rec.frame = frame;
}

function unmountView(rec) {
  if (!rec.frame) return;
  rec.frame.remove();
  URL.revokeObjectURL(rec.blobUrl);
  rec.frame = rec.blobUrl = null;
  rec.ready = false;
  rec.queue.length = 0;
}

/** Forward a guest's render bytes to its view (unread by the shell).
 *
 *  Renders that arrive before the view is ready are queued, except context renders:
 *  `viewReady` sends a fresh context first, and a stale one queued behind it would undo it.
 *  `fromPeer` lights the App tab's unread dot. */
function deliverRender(rec, payload, { fromPeer = false, isContext = false } = {}) {
  if (!rec.ui || payload.length === 0) return;
  if (rec.ready) postRender(rec.frame, payload);
  else if (!isContext) {
    rec.queue.push(payload);
    if (rec.queue.length > MAX_QUEUED_RENDERS) rec.queue.shift();
  }
  if (fromPeer && rec.key === activeAppKey && !tabs.app.btn.classList.contains("active")) {
    tabs.app.btn.classList.add("unread");
  }
}

/** A view is ready: send it a fresh context render first, then everything queued while it
 *  loaded, so it knows its rooms before drawing messages. */
async function viewReady(rec) {
  const frame = rec.frame;
  const context = await tellContext(rec);
  if (!frame || rec.frame !== frame) return; // removed or replaced meanwhile
  rec.ready = true;
  for (const payload of [context, ...rec.queue.splice(0)]) {
    if (payload.length > 0) postRender(frame, payload);
  }
}

/** Post a render to a view. Copied, not transferred: the same bytes are also the transport's
 *  reply to the peer. */
function postRender(frame, payload) {
  frame.contentWindow.postMessage({ type: "render", payload }, "*");
}

// ── reading a bundle ────────────────────────────────────────────────────
// Verify a bundle's signatures and read its facts for the UI and the consent gate. Throws
// for anything malformed, unauthentic or not runnable here (`appFacts`); this is where a
// bundle's `requires` is checked before anyone can consent to it.
function peekBundle(bundleBytes) {
  let v;
  try { v = verifyBundle(sodium, bundleBytes); }
  catch { throw new Error("not a valid app bundle (.skb)"); }
  return {
    key: v.manifest.app,
    authorPk: v.author.slice(),
    // What a consent names; also tells two bundles apart.
    hash: toHex(bundleDigest(v, digest)),
    ...appFacts(v.manifest),
  };
}

// Installs and removals run one at a time, so two of them never race on the same label
// (e.g. accepting an offer while a dropped file for that app is still installing).
let appChanges = Promise.resolve();
function queueAppChange(change) {
  const run = appChanges.then(change);
  appChanges = run.catch(() => {});
  return run;
}

// Install a bundle the user consented to (dropped, accepted from an offer, or restored after
// a reload) and return its AppRecord. `peeked` skips re-reading an already-read bundle.
async function applyAppBundle(bundleBytes, peeked = peekBundle(bundleBytes)) {
  return queueAppChange(() => installApp(bundleBytes, peeked));
}

async function installApp(bundleBytes, peeked) {
  const { key } = peeked;
  // Taking over a label takes its data too. Same author = upgrade; a different author's
  // bundle under the same label needs explicit confirmation.
  const standing = installedApps.get(key);
  if (standing && toHex(standing.authorPk) !== toHex(peeked.authorPk)
      && !confirm(`Replace ${standing.name} ${standing.version} with ${peeked.name} ${peeked.version} ` +
        `by a different author (${toHex(peeked.authorPk).slice(0, 12)}…)?`)) {
    throw new Error("replacing an app from a different author was declined");
  }

  const record = {
    ...peeked,
    bundleBytes,
    /** Hash of the raw bundle bytes, to spot a repeated offer before verifying it. */
    raw: toHex(digest(bundleBytes)),
    /** Calls into this app's guest. */
    invoke: null,
    frame: null,
    blobUrl: null,
    ready: false,
    queue: [],
    /** The context JSON last sent to its guest. */
    ctx: null,
    /** The conversation its view says is open: `{ room }` / `{ to }` (hex), null for none,
     *  undefined if the view never said. */
    conv: undefined,
  };

  // One-shot consent, withdrawn if the install doesn't consume it.
  pendingApprovals.add(peeked.hash);
  let loaded;
  try {
    loaded = await shell.install(bundleBytes, {
      // Replacing an installed label must be explicit (§12.4).
      replaces: standing ? key : undefined,
      // The guest's answer to a peer frame is render bytes for this app's view (§12.10).
      onInbound: (claim, from, answer) => deliverRender(record, answer, { fromPeer: true }),
    });
  } finally {
    pendingApprovals.delete(peeked.hash);
  }
  record.invoke = (arg) => loaded.invoke(arg);

  if (standing) unmountView(standing);
  installedApps.set(key, record);
  mountView(record);
  // Tell the new guest the context now, without waiting for its view.
  postContext();
  keepApp(record);
  renderAppList();
  return record;
}

// ── persistence ────────────────────────────────────────────────────────
// The signed bundles are all the app state we need; everything else (including protocol
// routing) derives from them. They're kept in sessionStorage as base64 so a reload restores
// them, along with the install order and the active app.
const appKey = (label) => `${STORE}.app.${label}`;
const appOrder = () => {
  try { return JSON.parse(sessionStorage.getItem(`${STORE}.order`) ?? "[]"); } catch { return []; }
};

/** Bytes to base64 (chunked, to stay under argument-count limits). */
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Save `rec` for reloads. If storage is full, say so; the app still runs until reload. */
function keepApp(rec) {
  try {
    sessionStorage.setItem(appKey(rec.key), toBase64(rec.bundleBytes));
    sessionStorage.setItem(`${STORE}.order`, JSON.stringify([...appOrder().filter((k) => k !== rec.key), rec.key]));
  } catch (err) {
    shellPrint(`${rec.name} will not be here after a reload: ${err.message}`, "err");
  }
}

function forgetApp(label) {
  try {
    sessionStorage.removeItem(appKey(label));
    sessionStorage.setItem(`${STORE}.order`, JSON.stringify(appOrder().filter((k) => k !== label)));
  } catch {}
}

function keepActiveApp() {
  try {
    if (activeAppKey) sessionStorage.setItem(`${STORE}.active`, activeAppKey);
    else sessionStorage.removeItem(`${STORE}.active`);
  } catch {}
}

async function restoreInstalledApps() {
  // Read before replaying, which changes the active app.
  const saved = sessionStorage.getItem(`${STORE}.active`);
  // Replaying in install order reproduces the same routing. Each was consented to when first
  // installed, so it's re-admitted with a fresh consent.
  for (const label of appOrder()) {
    const b64 = sessionStorage.getItem(appKey(label));
    if (!b64) continue;
    try { await applyAppBundle(fromBase64(b64)); }
    catch (err) { shellPrint(`Could not restore an app: ${err.message}`, "err"); }
  }
  if (saved && installedApps.has(saved)) setActiveApp(saved);
}

// ── the app shown ──────────────────────────────────────────────────────
function setActiveApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  if (!rec.frame) {
    shellPrint(`${rec.name} has no UI to show.`, "err");
    return;
  }
  activeAppKey = key;
  for (const r of installedApps.values()) r.frame?.classList.toggle("hidden", r !== rec);
  appEmpty.classList.add("hidden");
  appStatus.textContent = `${rec.name} ${rec.version}`.trim();
  keepActiveApp();
  renderAppList();
}

function showNoApp() {
  activeAppKey = null;
  for (const r of installedApps.values()) r.frame?.classList.add("hidden");
  appEmpty.classList.remove("hidden");
  appStatus.textContent = "no app loaded";
  keepActiveApp();
}

// ── peer-to-peer app offers ────────────────────────────────────────────
//
// An offer is a signed bundle sent over offer/v1 (shell-app.js). Anyone holding a bundle can
// forward it, and the recipient still verifies the original author's signature, which is
// what authenticates it; the forwarding peer is only identified by the channel.
//
// Offers wait in memory, keyed by digest, until accepted, dismissed or the page reloads.
const pendingOffers = new Map();   // bundle digest → { bundleBytes, raw, peeked, fromPkHex }

/** Max pending offers per peer (an offer costs the sender only one frame). */
const MAX_OFFERS_PER_PEER = 8;

/** Max size of an offered bundle. */
const MAX_OFFER_BYTES = 8 * 1024 * 1024;

function handleOffer(bundleBytes, fromPkHex) {
  const drop = (why) => shellPrint(`Offer from ${fromPkHex.slice(0, 8)} dropped: ${why}`, "err");
  // Cheap checks first: verifying a bundle (Ed25519 + ML-DSA) is the expensive part, and a
  // linked peer can send offers as fast as it likes.
  if (bundleBytes.length > MAX_OFFER_BYTES) return drop(`it is over ${MAX_OFFER_BYTES >> 20} MiB`);
  if ([...pendingOffers.values()].filter((o) => o.fromPkHex === fromPkHex).length >= MAX_OFFERS_PER_PEER) {
    return drop(`it has ${MAX_OFFERS_PER_PEER} waiting here already`);
  }
  // Skip bytes we already run or already have on offer, without verifying them again.
  const raw = toHex(digest(bundleBytes));
  if ([...pendingOffers.values(), ...installedApps.values()].some((o) => o.raw === raw)) return;
  let peeked;
  try { peeked = peekBundle(bundleBytes); }
  catch (err) { return drop(err.message); }
  // Same check by digest, which also catches identical content signed again.
  if (pendingOffers.has(peeked.hash) || [...installedApps.values()].some((rec) => rec.hash === peeked.hash)) return;
  pendingOffers.set(peeked.hash, { bundleBytes, raw, peeked, fromPkHex });
  renderOfferList();
  if (!tabs.apps.btn.classList.contains("active")) tabs.apps.btn.classList.add("unread");
  shellPrint(`${fromPkHex.slice(0, 8)} offers app "${peeked.name}" — see the Apps tab.`, "sys");
}

async function acceptOffer(hash) {
  const offer = pendingOffers.get(hash);
  if (!offer) return;
  try {
    const rec = await applyAppBundle(offer.bundleBytes, offer.peeked);
    pendingOffers.delete(hash);
    renderOfferList();
    shellPrint(`Installed ${rec.name} ${rec.version} from offer.`, "sys");
    setActiveApp(rec.key);
  } catch (err) {
    shellPrint(`Install from offer failed: ${err.message}`, "err");
    showAppsNotice(`Install from offer failed: ${err.message}`, "err");
  }
}

function dismissOffer(hash) {
  pendingOffers.delete(hash);
  renderOfferList();
}

// ── offering an app ─────────────────────────────────────────────────────
// Send an installed app's signed bundle to every linked peer. Only guests can send, so it
// goes through the shell app (`sendPage`). Recipients can forward it on.
async function offerApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  const linked = [...peers.linked.keys()];
  await Promise.all(linked.map((peerId) => sendPage(SHELL_OP_OFFER, peerId, rec.bundleBytes)
    .catch((err) => shellPrint(`offer to ${peerId.slice(0, 8)} failed: ${err.message}`, "err"))));
  const n = linked.length;
  shellPrint(
    n > 0
      ? `Offered ${rec.name} ${rec.version} to ${n} peer${n === 1 ? "" : "s"}.`
      : `No connected peers to offer ${rec.name} to.`,
    n > 0 ? "sys" : "err");
}

// ── apps panel UI ──────────────────────────────────────────────────────
// Installed and offered apps share one row layout (different buttons). The row shows what
// consent rests on: the protocols the app serves and what it reaches. `app` is the
// `peekBundle` facts, which an AppRecord also carries.

/** Row header: name, version and description, as the author wrote them. */
function appRowHead(li, app) {
  const head = document.createElement("div");
  head.className = "app-row-head";
  const nm = document.createElement("span");
  nm.className = "app-row-name";
  nm.textContent = app.name;
  head.appendChild(nm);
  if (app.version) {
    const v = document.createElement("span");
    v.className = "app-row-version";
    v.textContent = app.version;
    head.appendChild(v);
  }
  li.appendChild(head);
  if (app.description) {
    const d = document.createElement("div");
    d.className = "app-row-desc";
    d.textContent = app.description;
    li.appendChild(d);
  }
}

/** One line of `label value` pairs separated by dots. */
function appRowMeta(li, pairs) {
  const meta = document.createElement("div");
  meta.className = "app-row-meta";
  pairs.forEach(([label, value], i) => {
    const b = document.createElement("b");
    b.textContent = label;
    meta.append(b, document.createTextNode(` ${value}${i < pairs.length - 1 ? " · " : ""}`));
  });
  li.appendChild(meta);
}

/** What the bundle serves (claimed protocols, §12.10) and reaches (`requires`, §12.2), from
 *  its signed manifest. On an offer row, this is exactly what Install grants. */
function appRowClaims(li, app) {
  const line = document.createElement("div");
  line.className = "app-row-meta";
  const say = (label, value) => {
    const span = document.createElement("span");
    span.className = "app-row-proto";
    const b = document.createElement("b");
    b.textContent = label;
    span.append(b, document.createTextNode(` ${value}`));
    line.appendChild(span);
  };
  if (app.protocols.length === 0) say("serves", "no protocol — receives nothing");
  for (const proto of app.protocols) say("serves", `“${proto}”`);
  if (app.requires.length === 0) say("reaches", "nothing");
  for (const r of app.requires) say("reaches", APP_GRANTS[r]);
  li.appendChild(line);
}

/** A row for an installed or offered app. `from` is the offering peer; each button is
 *  `[label, class, onClick, disabled]`. */
function appRow(app, { className, from, buttons }) {
  const li = document.createElement("li");
  li.className = className;
  appRowHead(li, app);
  appRowMeta(li, [["id", app.key], ["author", toHex(app.authorPk).slice(0, 8)],
    ...(from ? [["from", from.slice(0, 8)]] : []), ["bundle", app.hash.slice(0, 12)]]);
  appRowClaims(li, app);
  const btns = document.createElement("div");
  btns.className = "app-row-buttons";
  for (const [label, cls, onClick, disabled = false] of buttons) {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    btns.appendChild(btn);
  }
  li.appendChild(btns);
  return li;
}

/** Placeholder row for an empty list. */
function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "empty-row";
  li.textContent = text;
  return li;
}

function renderAppList() {
  if (installedApps.size === 0) { appListEl.replaceChildren(emptyRow("No apps installed yet.")); return; }
  appListEl.replaceChildren(...[...installedApps.values()].map((rec) => {
    const active = rec.key === activeAppKey;
    return appRow(rec, {
      className: active ? "app-row active" : "app-row",
      buttons: [
        ...(rec.frame ? [[active ? "Active" : "Open", "icon primary", () => { setActiveApp(rec.key); showTab("app"); }, active]] : []),
        ["Offer to peers", "icon", () => offerApp(rec.key)],
        ["Remove", "icon danger", () => removeApp(rec.key)],
      ],
    });
  }));
}

function removeApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  if (!confirm(`Remove ${rec.name} ${rec.version}? The app will be uninstalled.`)) return;
  void queueAppChange(() => {
    // Replaced while the dialog was open: that's not the app the user chose to remove.
    if (installedApps.get(key) !== rec) {
      shellPrint(`${rec.name} ${rec.version} was replaced meanwhile, so it was not removed.`, "err");
      return;
    }
    // Uninstall drops the label's slot: its protocol claims and guest realm (§12.5).
    shell.uninstall(key);
    installedApps.delete(key);
    unmountView(rec);
    if (activeAppKey === key) showNoApp();
    forgetApp(key);
    renderAppList();
  });
}

function renderOfferList() {
  offersSection.hidden = pendingOffers.size === 0;
  offerListEl.replaceChildren(...[...pendingOffers].map(([hash, offer]) => appRow(offer.peeked, {
    className: "app-row offer-row",
    from: offer.fromPkHex,
    buttons: [["Install", "icon primary", () => acceptOffer(hash)], ["Dismiss", "icon", () => dismissOffer(hash)]],
  })));
}

// ── drag-drop + file picker plumbing ───────────────────────────────────
async function loadDroppedFile(file) {
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Dropping a file is the consent (§12.4). A bundle this shell won't run is refused with
  // the reason.
  try {
    const record = await applyAppBundle(bytes);
    shellPrint(`Installed ${record.name} ${record.version}`, "sys");
    setActiveApp(record.key);
  } catch (err) {
    shellPrint(`Install failed: ${err.message}`, "err");
    showAppsNotice(`Install failed: ${err.message}`, "err");
  }
}

dropzone.addEventListener("click", () => appFileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    appFileInput.click();
  }
});
appFileInput.addEventListener("change", async () => {
  const f = appFileInput.files && appFileInput.files[0];
  appFileInput.value = "";
  if (f) await loadDroppedFile(f);
});
;["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add("dragover");
  }));
;["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ev !== "drop") dropzone.classList.remove("dragover");
  }));
dropzone.addEventListener("drop", async (e) => {
  dropzone.classList.remove("dragover");
  const dt = e.dataTransfer;
  if (!dt || !dt.files || dt.files.length === 0) return;
  for (const f of dt.files) await loadDroppedFile(f);
});
openAppsBtn.addEventListener("click", () => showTab("apps"));

// ─── what a view says to the shell ─────────────────────────────────────
// Messages from views (app-api.js). `ready` and `call` concern the view's own app; the shell
// passes call bytes through unread. `conv` and `contact` ask the shell about rooms and
// peers. Views are untrusted pages, so every message is shape-checked.

/** Whether `v` is 32 bytes of lowercase hex (a key or room id). */
const isHex32 = (v) => typeof v === "string" && HEX32_RE.test(v);

window.addEventListener("message", (ev) => {
  const rec = [...installedApps.values()].find((r) => r.frame && r.frame.contentWindow === ev.source);
  const msg = ev.data;
  if (!rec || !msg) return;

  if (msg.type === "ready") { void viewReady(rec); return; }

  // Bytes for the app's guest. Every call gets an answer (the guest's reply or its error),
  // so a view never waits forever.
  if (msg.type === "call") {
    if (!(msg.bytes instanceof Uint8Array) || !Number.isSafeInteger(msg.id)) return;
    // The app may be gone by now. The answer is this call's alone, so transfer it.
    const answer = (fields, transfer = []) => rec.frame?.contentWindow.postMessage({ type: "answer", id: msg.id, ...fields }, "*", transfer);
    invokeApp(rec, APP_OP_UI, msg.bytes).then((payload) => answer({ payload }, ownsBuffer(payload) ? [payload.buffer] : []), (err) => {
      shellPrint(`${rec.name}: ${err.message}`, "err");
      answer({ error: err.message });
    });
    return;
  }

  // The conversation open in the view (room, peer or none); calls started now go there.
  if (msg.type === "conv") {
    rec.conv = isHex32(msg.room) ? { room: msg.room } : isHex32(msg.to) ? { to: msg.to } : null;
    // The call bar shows who a call would ring, which just changed.
    updateCallStatus();
    return;
  }

  // Make a peer a contact (so the link outlives shared rooms), typically before a view
  // messages it directly. Only peers the node already knows (a room-mate or linked peer) are
  // allowed; otherwise a view could make the node dial any key. Other keys must be added by
  // the user on the Network tab.
  if (msg.type === "contact") {
    if (!isHex32(msg.peer) || peers.contacts.has(msg.peer) || msg.peer === myPkHex) return;
    if (!peers.linked.has(msg.peer) && peers.roomsOf(msg.peer).length === 0) {
      shellPrint(`${rec.name} asked to make ${msg.peer.slice(0, 8)} a contact, which is not a peer this node ` +
        "shares a room with or is linked to. Add it on the Network tab to link to it.", "err");
      return;
    }
    addContact(msg.peer, null);
  }
});

/** Whether `bytes` spans its whole buffer, so transferring the buffer exposes nothing else. */
const ownsBuffer = (bytes) => bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;

// ---------------------------------------------------------------------------
// Networking. The transport bundle (a confined guest) does the handshake, encryption,
// relay registration, the move to WebRTC and redialing (§12.6, §12.7); net-rtc only holds
// the RTCPeerConnections. Who we want linked is peers.js's. Below is what's the page's own:
// UI, persistence across reloads, and telling peers about contact changes.
//
// The relay secret (seedrelay's `--secret`) belongs to the relay operator, so it is never
// put in shared links.
// ---------------------------------------------------------------------------

// Nicks belong to the shell, not to apps. Shells exchange them over shell/v1 and every app
// reads them from the context, so a name is the same everywhere.

/** Set our nick ("" for none). Peers and apps are told. */
function setMyNick(nick) {
  peers.setNick(nick);
  if (peers.nick) sessionStorage.setItem("shell.nick", peers.nick);
  else sessionStorage.removeItem("shell.nick");
  nickInput.value = peers.nick;
  postContext();
  shellPrint(peers.nick ? `You are now known as ${peers.nick}.` : "You no longer have a nick.", "sys");
}
nickInput.value = peers.nick;
nickSetBtn.addEventListener("click", () => setMyNick(nickInput.value));
onEnter(nickInput, () => setMyNick(nickInput.value));

/** Make `key` a contact (secret or null). It's told once linked, so it adds us back;
 *  `tell: false` when it told us first. */
function addContact(key, secret, { tell = true } = {}) {
  if (key === myPkHex) return;
  if (!peers.contacts.has(key)) {
    if (tell) untoldPeers.set(key, true); else untoldPeers.delete(key);
  }
  peers.addContact(key, secret);
  saveContacts();
  renderRoomList();
}

/** Remove contact `key` and tell it, unless it told us first. */
function removeContact(key, { tell = true } = {}) {
  const before = [...peers.wanted.keys()];
  // A peer never told it was added doesn't need a removal notice.
  const knows = untoldPeers.get(key) !== true;
  untoldPeers.delete(key);
  peers.removeContact(key);
  saveContacts();
  renderRoomList();
  if (!tell || !knows) { peers.hangUpUnwanted(before); return; }
  void tellRemoved(key, before);
}

/** The shell/v1 notice that we added (true) or removed (false) a peer. */
const peerNotice = (added) => new TextEncoder().encode(JSON.stringify({ peer: added }));

/** Tell `key` we removed it, then hang up on peers in `before` no longer wanted. (A closing
 *  link still delivers what was sent first, §12.6.) If `key` isn't linked, the notice is
 *  queued, since sending would dial it. */
async function tellRemoved(key, before) {
  let told = false;
  try {
    if (peers.linked.has(key)) told = await tellPage(key, peerNotice(false));
  } catch { /* not told: owed, below */ }
  if (!told && !peers.contacts.has(key)) untoldPeers.set(key, false);
  peers.hangUpUnwanted(before);
}

/** Send queued add/remove notices to peers that are now linked. */
function tellPeers() {
  for (const [key, added] of [...untoldPeers]) {
    if (!peers.linked.has(key)) continue;
    untoldPeers.delete(key);
    const told = tellPage(key, peerNotice(added)).catch(() => {});
    // A removed peer that relinked is told again, then hung up on.
    if (!added) void told.then(() => peers.hangUpUnwanted([key]));
  }
}

/** Re-add `key` as a contact and dial it fresh with `secret` (or none). */
function recontact(key, secret) {
  peers.callAfresh(key);
  addContact(key, secret);
}

/** A contact row's Connect: dial with the secret in its field. */
function connectPeer(key, field) {
  const secret = readHex32(field, "A contact secret is 64 hex characters.");
  if (secret !== undefined) recontact(key, secret);
}

/** Set our contact secret, or null to accept any caller (§12.6.3). Existing links stay up,
 *  and room-mates are always answered. */
async function setMyContact(secret) {
  await peers.net(new OpArgs("contact").blob(secret ?? new Uint8Array(0)));
  myContactSecret = secret;
  if (secret) sessionStorage.setItem("shell.contactSecret", toHex(secret));
  else sessionStorage.removeItem("shell.contactSecret");
  updateContactHint();
}

// Render the empty lists, then restore apps saved earlier in this tab, so forwarding offers
// works as soon as peers connect.
renderAppList();
renderOfferList();
restoreInstalledApps().catch((err) =>
  shellPrint(`Restore failed: ${err.message}`, "err"));

// ─── live audio/video calls ────────────────────────────────────────────
//
// Calls use MediaCalls (media-rtc.js), signaled through the shell app. Starting a call
// rings the conversation open in the app (a room's linked members, or one peer), and
// `followPeers` keeps that up to date (`callPeers`). A ringing peer only sees who is calling;
// no media flows either way until it accepts (`incomingCall`). Mic and camera start on and
// have their own toggles (`capture`, `release`). Remote tracks land in per-peer tiles.
//
// Calls live here, not in app views, because a sandboxed view has an opaque origin and
// `getUserMedia` fails there with a SecurityError regardless of the iframe's `allow`.

const callBar      = document.getElementById("call-bar");
const callStartBtn = document.getElementById("call-start");
const callDeclineBtn = document.getElementById("call-decline");
const callMuteBtn  = document.getElementById("call-mute");
const callCamBtn   = document.getElementById("call-cam");
const callEndBtn   = document.getElementById("call-end");
const callStatus   = document.getElementById("call-status");
const videoTiles   = document.getElementById("video-tiles");

// Our captured mic/camera tracks during a call (minus any that are off), or null.
let localStream = null;
const remoteTiles = new Map(); // pkHex -> { wrap, video, stream }
// The conversation of the current call: the app's `conv` when it started (`{ room }` /
// `{ to }`, null for none), or undefined if the app never said or none was shown.
let callScope;

/** Linked peer keys, hex. */
const linkedKeys = () => [...peers.linked.keys()];

/** Members of the joined room with this id (empty if not joined). */
const membersOf = (id) => peers.roomById(id)?.[1].members ?? new Set();

/** The linked peers in a call with `scope`: a room's members, or one peer. With undefined
 *  scope (the app never said), everyone linked. */
function peersIn(scope, linked) {
  if (scope === undefined) return linked;
  if (scope === null) return [];
  if (scope.to) return linked.filter((p) => p === scope.to);
  const members = membersOf(scope.room);
  return linked.filter((p) => members.has(p));
}

/** The linked peers in the current call. */
const callPeers = (linked) => peersIn(callScope, linked);

/** Describe, in the shell's own words, who a call with `scope` would ring. The open
 *  conversation is the view's claim, so the call bar states the result for the user. */
function callTarget(scope) {
  const n = peersIn(scope, linkedKeys()).length;
  if (scope === undefined) {
    return n === 0 ? "nobody, since no peer is linked" : n === 1 ? "the 1 linked peer" : `all ${n} linked peers`;
  }
  if (scope === null) return "nobody, since no conversation is open in the app";
  if (scope.to) return n > 0 ? peers.label(scope.to) : `${peers.label(scope.to)}, who is not linked`;
  const [room] = peers.roomById(scope.room) ?? [];
  if (!room) return "nobody, since this node is not in that room";
  return n === 0 ? `nobody, since no one in ${friendlyRoom(room)} is linked` : `the ${n} linked in ${friendlyRoom(room)}`;
}

/** The call's shared name: the room id, "direct" for one peer, or "all". */
const callName = (scope) => scope === undefined ? "all" : scope?.room ?? "direct";

/** The key a declined call is remembered by: the peer for a direct call, else its name. */
const callId = (peer, call) => call === "direct" ? peer : call;

// Declined or hung-up calls (by `callId`); they don't ring again while still going.
const declined = new Set();

/** The first incoming call we could join and haven't declined, as
 *  `{ id, scope, callers }`, or null. A room call counts only if its caller is in that room
 *  with us. */
function incomingCall() {
  const callers = media.callers;
  for (const [from, call] of callers) {
    const direct = call === "direct";
    if (!direct && call !== "all" && !membersOf(call).has(from)) continue;
    if (declined.has(callId(from, call))) continue;
    return {
      id: callId(from, call),
      scope: direct ? { to: from } : call === "all" ? undefined : { room: call },
      callers: direct ? [from] : [...callers].filter(([, c]) => c === call).map(([p]) => p),
    };
  }
  return null;
}

/** Call participants changed: forget declines for calls that have ended, and update the
 *  call bar. */
function callersChanged() {
  const live = new Set([...media.callers].map(([from, call]) => callId(from, call)));
  for (const id of [...declined]) if (!live.has(id)) declined.delete(id);
  updateCallStatus();
}

function updateCallStatus() {
  const ring = localStream ? null : incomingCall();
  callStartBtn.textContent = ring ? "Accept call" : "Start call";
  callStartBtn.classList.toggle("primary", !!ring);
  callBar.classList.toggle("ringing", !!ring);
  callBar.classList.toggle("idle", !localStream);
  if (ring) {
    const [first, ...more] = ring.callers;
    const [room] = (ring.scope?.room && peers.roomById(ring.scope.room)) || [];
    callStatus.textContent = `${peers.label(first)}${more.length > 0 ? ` and ${more.length} more are` : " is"} calling` +
      (room ? ` in ${friendlyRoom(room)}` : "");
  } else if (!localStream) {
    // Show who a call started now would ring.
    callStatus.textContent = `a call rings ${callTarget(installedApps.get(activeAppKey)?.conv)}`;
  } else {
    const n = media.size;
    callStatus.textContent = n === 0
      ? "in call (waiting for peers)"
      : `in call · ${n} peer${n === 1 ? "" : "s"}`;
  }
}

function showTilesIfAny() {
  videoTiles.classList.toggle("hidden", !localTile && remoteTiles.size === 0);
}

/** Show a tile's video, or just its label when there's no live video (no camera, or the
 *  peer turned it off, which mutes the track). */
function drawTile(wrap, stream) {
  const video = stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
  wrap.classList.toggle("no-video", !video);
}

/** Create a video tile with a label. Our own plays muted. */
function makeTile(label, stream, own) {
  const wrap = document.createElement("div");
  wrap.className = own ? "tile local" : "tile";
  if (own) wrap.id = "tile-local";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = own;
  video.playsInline = true;
  video.srcObject = stream;
  const lab = document.createElement("div");
  lab.className = "tile-label";
  lab.textContent = label;
  wrap.append(video, lab);
  videoTiles.appendChild(wrap);
  return { wrap, video, stream };
}

// Our own tile during a call.
let localTile = null;

function removeTile(tile) {
  tile.video.srcObject = null;
  tile.wrap.remove();
}

function ensureLocalTile() {
  localTile ??= makeTile(`me · ${myPkHex.slice(0, 8)}`, localStream, true);
  showTilesIfAny();
}

function removeLocalTile() {
  if (!localTile) return;
  removeTile(localTile);
  localTile = null;
  showTilesIfAny();
}

function getOrCreateRemoteTile(pkHex) {
  let t = remoteTiles.get(pkHex);
  if (t) return t;
  t = makeTile(pkHex.slice(0, 8), new MediaStream(), false);
  remoteTiles.set(pkHex, t);
  showTilesIfAny();
  updateCallStatus();
  return t;
}

function removeRemoteTile(pkHex) {
  const t = remoteTiles.get(pkHex);
  if (!t) return;
  removeTile(t);
  remoteTiles.delete(pkHex);
  showTilesIfAny();
  updateCallStatus();
}

/** Start a call with the open conversation, or accept the ringing one, with mic and camera
 *  on. If the browser grants neither, the call continues with both off. */
function startCall() {
  if (localStream) return;
  // If a call is ringing, this accepts it, whatever the app has open.
  const ring = incomingCall();
  localStream = new MediaStream();
  callScope = ring ? ring.scope : installedApps.get(activeAppKey)?.conv;
  media.start(callName(callScope), callPeers, linkedKeys());
  callStartBtn.disabled = true;
  callEndBtn.disabled = false;
  ensureLocalTile();
  showCapture();
  updateCallStatus();
  shellPrint(ring ? "Call accepted." : `Call started with ${callTarget(callScope)}.`, "sys");
  void capture({ audio: true, video: true });
}

function endCall() {
  if (!localStream) return;
  // Don't ring again for this call while others are still in it.
  declined.add(callId(callScope?.to, callName(callScope)));
  media.end();
  for (const t of localStream.getTracks()) t.stop();
  localStream = null;
  removeLocalTile();
  for (const pkHex of Array.from(remoteTiles.keys())) removeRemoteTile(pkHex);
  callStartBtn.disabled = false;
  callMuteBtn.disabled = true;
  callCamBtn.disabled = true;
  callEndBtn.disabled = true;
  showCapture();
  callersChanged();
  shellPrint("Call ended.", "sys");
}

/** Decline the ringing call. Callers aren't told; it just stops ringing here. */
function declineCall() {
  const ring = incomingCall();
  if (!ring) return;
  declined.add(ring.id);
  updateCallStatus();
}

/** Update the mic/camera button labels and our own tile. */
function showCapture() {
  const [mic] = localStream?.getAudioTracks() ?? [];
  const [cam] = localStream?.getVideoTracks() ?? [];
  callMuteBtn.textContent = mic?.enabled ? "Mute" : "Unmute";
  callCamBtn.textContent = cam ? "Stop video" : "Start video";
  if (localTile) drawTile(localTile.wrap, localStream);
}

/** Capture the mic (`audio`), camera (`video`) or both, and publish to the call, including
 *  to peers who join later. */
async function capture(what) {
  const stream = localStream;
  if (what.audio) callMuteBtn.disabled = true;
  if (what.video) callCamBtn.disabled = true;
  let tracks = [];
  try {
    tracks = (await navigator.mediaDevices.getUserMedia(what)).getTracks();
  } catch (err) {
    shellPrint(`getUserMedia failed: ${err.message}`, "err");
  }
  // Hung up while the browser was asking: discard the tracks.
  if (localStream !== stream) { for (const t of tracks) t.stop(); return; }
  if (what.audio) callMuteBtn.disabled = false;
  if (what.video) callCamBtn.disabled = false;
  for (const track of tracks) {
    // The track ends if the device is unplugged or permission is withdrawn.
    track.addEventListener("ended", () => release(track));
    stream.addTrack(track);
    media.publish(track, stream);
  }
  showCapture();
}

/** Stop sending and capturing a track. */
function release(track) {
  if (!localStream?.getTracks().includes(track)) return;
  media.unpublish(track);
  track.stop();
  localStream.removeTrack(track);
  showCapture();
}

/** Mute only disables the mic track (it stays captured, so unmute is instant). If we never
 *  got a mic, ask for one. */
function toggleMute() {
  if (!localStream) return;
  const [mic] = localStream.getAudioTracks();
  if (!mic) { void capture({ audio: true }); return; }
  mic.enabled = !mic.enabled;
  showCapture();
}

/** The camera is only captured while video is on, so stopping video releases it. */
function toggleCamera() {
  if (!localStream) return;
  const [cam] = localStream.getVideoTracks();
  if (cam) release(cam); else void capture({ video: true });
}

callStartBtn.addEventListener("click", startCall);
callDeclineBtn.addEventListener("click", declineCall);
callEndBtn.addEventListener("click", endCall);
callMuteBtn.addEventListener("click", toggleMute);
callCamBtn.addEventListener("click", toggleCamera);

// ─── relay connection ───────────────────────────────────────────────────
//
// Restart ICE on call connections as soon as the network changes, rather than waiting
// 5–10 s for keepalives to notice. The transport handles its own connections (§12.7).
window.addEventListener("online", () => {
  shellPrint("Network online — restarting ICE", "sys");
  media.restartAllIce();
});
if (navigator.connection && typeof navigator.connection.addEventListener === "function") {
  navigator.connection.addEventListener("change", () => {
    shellPrint("Network changed — restarting ICE", "sys");
    media.restartAllIce();
  });
}

// The room joined when none is typed.
const DEFAULT_ROOM = "global";

// Split a relay URL into its origin and an optional room from the path
// (so `ws://host:8080/my-room` works in the URL field).
function parseRelay(base) {
  let u;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
  return { origin: `${u.protocol}//${u.host}`, room: decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, "")) };
}

// The current or last Connect: `{ base, joining }`, base being the URL as typed (saved for
// reloads). null after Disconnect. The relay itself is tracked in `peers.relay`.
let relayJoin = null;

/** Check a room name, logging an error if invalid. */
function roomNameOk(room) {
  if (ROOM_NAME_RE.test(room)) return true;
  shellPrint("Room name must match [A-Za-z0-9._-] (up to 128 chars).", "err");
  return false;
}

/** Connect: register on the relay in the URL field (so our key can be called) and join our
 *  rooms there. A room in the URL's path is joined too. */
async function connectRelay() {
  const base = relayUrlInput.value.trim();
  if (!base) { shellPrint("Enter a relay URL.", "err"); return; }
  const target = parseRelay(base);
  if (!target) { shellPrint("Relay URL must be ws:// or wss://.", "err"); return; }
  if (target.room && !roomNameOk(target.room)) return;
  const relaySecret = relaySecretInput.value.trim() || null;
  const join = relayJoin = { base, joining: true };
  try {
    relayShown = -1;
    relayStatus.textContent = "connecting...";
    setRelayPill("connecting", "connecting");
    shellPrint(`Connecting to ${target.origin}...`, "sys");
    if (target.room) await peers.joinRoom(target.room);
    const joined = peers.joinRelay(target.origin, relaySecret);
    showRelayButton();
    await joined;
    if (relayJoin !== join) return; // disconnected meanwhile, or connecting elsewhere
    join.joining = false;
    showRelay();
  }
  catch (err) {
    if (relayJoin !== join) return;
    join.joining = false;
    relayStatus.textContent = "error";
    setRelayPill("err", "relay error");
    shellPrint(`Relay connection failed: ${err?.message ?? err}`, "err");
  }
}

/** Disconnect from the relay. Rooms are kept for the next Connect. */
async function disconnectRelay() {
  if (!peers.relay) return;
  relayJoin = null;
  relayShown = 0;
  const left = peers.leaveRelay();
  showRelayButton();
  // Don't reconnect after a reload either.
  sessionStorage.removeItem("shell.relayUrl");
  sessionStorage.removeItem("shell.relaySecret");
  await left;
  showRelayState(0);
  shellPrint("Disconnected from the relay.", "sys");
}

/** The relay button reads Disconnect while connected or connecting. */
function showRelayButton() {
  relayConnectBtn.textContent = peers.relay ? "Disconnect" : "Connect";
  relayConnectBtn.classList.toggle("primary", !peers.relay);
}

// Relay state from the transport: 0 none, 1 registered, 2 redialing (§12.6). Shown only
// when it changes, and not while a Connect is in progress (that shows "connecting" until
// it resolves). -1 forces the next state to show; 0 means nothing shown since Disconnect.
let relayShown = -1;
function showRelay() {
  if (peers.relayState === relayShown || relayJoin?.joining) return;
  relayShown = peers.relayState;
  showRelayState(peers.relayState);
}

/** The joined rooms in a few words, for the pill and status line. */
function roomsLabel() {
  const names = [...peers.rooms.keys()].map(friendlyRoom);
  return names.length === 0 ? "no room" : names.length === 1 ? `room ${names[0]}` : `${names.length} rooms`;
}

/** Show the relay as connected, naming the rooms if any. */
function showConnected() {
  relayStatus.textContent = `connected · ${roomsLabel()}`;
  setRelayPill("ok", peers.rooms.size === 0 ? "connected" : roomsLabel());
}

function showRelayState(state) {
  if (!relayJoin || !peers.relay || state === 0) {
    relayStatus.textContent = "disconnected";
    setRelayPill("off", "no relay");
    return;
  }
  const { origin, relaySecret } = peers.relay;
  if (state === 1) {
    shellPrint(`Relay link up — ${roomsLabel()}.`, "sys");
    showConnected();
    // Save the relay so a reload reconnects (and rejoins rooms) automatically.
    sessionStorage.setItem("shell.relayUrl", relayJoin.base);
    // The relay secret is saved and cleared together with the relay.
    if (relaySecret) sessionStorage.setItem("shell.relaySecret", relaySecret);
    else sessionStorage.removeItem("shell.relaySecret");
  } else {
    relayStatus.textContent = "unreachable — retrying";
    setRelayPill("err", "relay down");
    // A private relay drops a node with the wrong secret, which looks like unreachable here.
    shellPrint(`Relay unreachable — is one running at ${origin}, and if it is private, is the relay secret right? ` +
      "Retrying; existing P2P links are unaffected.", "err");
  }
}

/** Join the typed room (or the default), in addition to any joined. Connects to the relay
 *  if needed. */
async function joinTypedRoom() {
  const room = relayRoomInput.value.trim() || DEFAULT_ROOM;
  if (!roomNameOk(room)) return;
  try {
    shellPrint(`Joining room ${friendlyRoom(room)}...`, "sys");
    await peers.joinRoom(room);
    relayRoomInput.value = "";
  }
  catch (err) {
    shellPrint(`Could not join room ${friendlyRoom(room)}: ${err?.message ?? err}`, "err");
    return;
  }
  if (!peers.relay) await connectRelay();
}

showRelay();
relayConnectBtn.addEventListener("click", () => (peers.relay ? disconnectRelay() : connectRelay()));
roomJoinBtn.addEventListener("click", joinTypedRoom);
onEnter(relayUrlInput, connectRelay);
onEnter(relaySecretInput, connectRelay);
onEnter(relayRoomInput, joinTypedRoom);

// The Network tab's room list: each room with its members, a share link and Leave.
function renderRoomList() {
  if (peers.rooms.size === 0) roomListEl.replaceChildren(emptyRow("No room joined."));
  else roomListEl.replaceChildren(...[...peers.rooms].map(([name, r]) => {
    const li = document.createElement("li");
    li.className = "peer-row room-row";
    const label = document.createElement("span");
    label.className = "peer-row-id";
    label.textContent = friendlyRoom(name);
    label.title = name;
    const count = document.createElement("span");
    count.className = "peer-row-where";
    count.textContent = r.members.size === 0 ? "no other peers"
      : r.members.size === 1 ? "1 other peer" : `${r.members.size} other peers`;
    const copy = iconButton("Copy link", () => void copyOrPrint(roomLink(name),
      `Link to room ${friendlyRoom(name)} copied. Anyone with it can join.`, "link"));
    const leave = iconButton("Leave", () => void peers.leaveRoom(name));
    li.append(label, count, copy, leave);
    // One line per member, with Add peer for those not yet contacts.
    if (r.members.size > 0) {
      const members = document.createElement("div");
      members.className = "room-members";
      for (const key of [...r.members].sort()) {
        const member = document.createElement("div");
        member.className = "room-member";
        const id = document.createElement("span");
        id.className = "peer-row-id";
        id.textContent = peers.label(key);
        id.title = key;
        member.appendChild(id);
        if (!peers.contacts.has(key)) {
          member.appendChild(iconButton("Add peer", () => addContact(key, null),
            "Make this peer a contact: stay linked whether or not you share a room."));
        }
        members.appendChild(member);
      }
      li.appendChild(members);
    }
    return li;
  }));
  if (peers.relay && relayShown === 1) showConnected();
}

// ── links ──────────────────────────────────────────────────────────────────
//
// Room link: `#room=<name>`. Anyone with the name can join, so private rooms need an
// unguessable name ("Random"). Contact link: `#pk=<key>[&s=<secret>]`. Both live in the URL
// fragment, which browsers never send, so the relay never learns room names or secrets.

/** Parse `room=` and `pk=`/`s=` from a link or its fragment. */
function parseLink(text) {
  const q = new URLSearchParams(text.slice(text.indexOf("#") + 1));
  const room = q.get("room") ?? "";
  const pk = (q.get("pk") ?? "").toLowerCase(), s = (q.get("s") ?? "").toLowerCase();
  return {
    room: ROOM_NAME_RE.test(room) ? room : undefined,
    contact: HEX32_RE.test(pk) ? { key: pk, secret: HEX32_RE.test(s) ? fromHex(s) : null } : undefined,
  };
}

const pageUrl = () => location.origin + location.pathname + location.search;
const roomLink = (name) => `${pageUrl()}#${new URLSearchParams({ room: name })}`;
/** Our contact link: key, plus secret if set. */
function contactLink() {
  const q = new URLSearchParams({ pk: myPkHex });
  if (myContactSecret) q.set("s", toHex(myContactSecret));
  return `${pageUrl()}#${q}`;
}

/** Explain the contact secret, since a caller without it gets no error, just silence. */
function updateContactHint() {
  contactHint.innerHTML = myContactSecret
    ? "Someone who is not in a room with you must present this node's <strong>contact secret</strong> " +
      "to connect. <strong>Copy contact link</strong> carries it, with your key."
    : "This node has <strong>no contact secret</strong>: anyone on the relay who has its key can connect. " +
      "Set one to answer only your room-mates and whoever you give it to.";
}

// "Random": append 16 random bytes so the room name can't be guessed (see seedrelay's
// README). Lowercase hex survives case-insensitive copy paths.
relayNewRoomBtn.addEventListener("click", () => {
  const name = friendlyRoom(relayRoomInput.value.trim()).slice(0, 95) || "room";
  relayRoomInput.value = `${name}-${toHex(sodium.randombytes_buf(16))}`;
  shellPrint("Private room name minted — press Join, then share its link.", "sys");
  relayRoomInput.focus();
});

/** Copy `text` to the clipboard, or print it to the log if that fails (permission denied,
 *  file://), so the button never silently does nothing. */
async function copyOrPrint(text, copied, what) {
  try {
    await navigator.clipboard.writeText(text);
    shellPrint(copied, "sys");
  } catch {
    shellPrint(`Copy failed — here is the ${what}: ${text}`, "sys");
  }
}

/** Apply the contact secret field: 64 hex chars, or empty for none. */
async function applyContactField() {
  const secret = readHex32(contactInput, "A contact secret is 64 hex characters, or empty for none.");
  if (secret === undefined) return;
  try { await setMyContact(secret); }
  catch (err) { shellPrint(`Could not set the contact secret: ${err.message}`, "err"); }
}
hexField(contactInput, () => void applyContactField());
contactSetBtn.addEventListener("click", () => void applyContactField());
contactNewBtn.addEventListener("click", () => {
  contactInput.value = toHex(sodium.randombytes_buf(32));
  void applyContactField();
});
contactCopyBtn.addEventListener("click", () => void copyOrPrint(contactLink(), myContactSecret
  ? "Contact link copied — it carries this node's key and contact secret. Anyone with it can connect to you."
  : "Contact link copied — this node's key; it has no contact secret.", "link"));

/** "Add peer": accepts a contact link, or a key plus optional secret. */
function addContactFromFields() {
  const typed = contactAddInput.value.trim();
  const linked = parseLink(typed).contact;
  const key = linked ? linked.key : typed.toLowerCase();
  const refuse = (why) => { contactAddInput.setCustomValidity(why); contactAddInput.reportValidity(); };
  if (!HEX32_RE.test(key)) return refuse("A contact is a contact link, or a key of 64 hex characters.");
  if (key === myPkHex) return refuse("That is this node's own key.");
  const secret = readHex32(contactAddSecretInput, "A contact secret is 64 hex characters.");
  if (secret === undefined) return;
  recontact(key, secret ?? linked?.secret ?? null);
  contactAddInput.value = contactAddSecretInput.value = "";
  shellPrint(`Contact ${key.slice(0, 8)} added.`, "sys");
}
contactAddBtn.addEventListener("click", addContactFromFields);
hexField(contactAddInput, addContactFromFields);
hexField(contactAddSecretInput, addContactFromFields);

// Default relay URL: the page's own host, so a phone loading the shell from a desktop's LAN
// IP gets the right value. An HTTPS page can only use wss://, so it assumes the same origin
// proxies the relay (as seedrelay's droplet script sets up). "localhost" on file://.
function defaultRelayUrl() {
  if (location.protocol === "https:") return `wss://${location.host}`;
  const host = location.hostname || "localhost";
  return `ws://${host}:8080`;
}

// React to any change in links, relay state or wanted peers (peers.js `follow`): send owed
// notices, redraw, update every app's context, and keep the call in step. Event-driven only.
function followPeers() {
  tellPeers();
  updatePeerPill();
  renderPeerList();
  postContext();
  media.sync(linkedKeys());
  updateCallStatus();
}

// Restore the relay, rooms and secrets saved in this tab, and reconnect. Rejoining a room
// announces our key, and its members link to the reloaded tab.
const savedRelayUrl = sessionStorage.getItem("shell.relayUrl");
const savedRelaySecret = sessionStorage.getItem("shell.relaySecret");
relayUrlInput.value = savedRelayUrl || defaultRelayUrl();
if (savedRelaySecret) relaySecretInput.value = savedRelaySecret;
if (myContactSecret) contactInput.value = toHex(myContactSecret);
let savedRooms = [];
try { savedRooms = JSON.parse(sessionStorage.getItem("shell.rooms") ?? "[]"); } catch {}

// Apply a followed link (join its room, add its contact), then strip it from the address
// bar so a contact secret doesn't linger there.
const followed = parseLink(location.hash);
if (followed.room) {
  savedRooms.push(followed.room);
  shellPrint(`Room link: ${friendlyRoom(followed.room)}.`, "sys");
}
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
for (const name of savedRooms) {
  if (typeof name === "string" && ROOM_NAME_RE.test(name) && !peers.rooms.has(name)) {
    peers.rooms.set(name, { id: await roomId(name), members: new Set() });
  }
}
updateContactHint();
peers.roomsChanged();
if (followed.contact && followed.contact.key !== myPkHex) {
  addContact(followed.contact.key, followed.contact.secret);
  shellPrint(`Contact link: ${followed.contact.key.slice(0, 8)}` +
    (followed.contact.secret ? ", with its contact secret." : "."), "sys");
}
if (savedRelayUrl) connectRelay();
