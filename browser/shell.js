// seedkernel is a dependency, not a sibling directory. Every specifier below is
// a *published* entry point of seedkernel-wasm (its package.json "exports"), so
// this file can only reach what seedkernel has deliberately made public — the
// import map in shell.html resolves them to the vendored build. If a future
// seedkernel change breaks the shell, it broke a public export, which is the point.
// The page imports the host (§12.9) and runs it on the browser platform, which takes only
// the host blob's realm engine and crypto: nothing is evaluated from a string, so the page's
// CSP needs no 'unsafe-eval'. The node is assembled by that host's `standUp`: the transport
// bundle pinned to its own author, the channel adapter built from the `transport` options
// passed to it. The page's admit is then ONLY its consent gate — who may be the network is
// the assembly's, so nobody can lose it by forgetting it.
import { browserPlatform } from "seedkernel-wasm/platform-web";
import { platformHost } from "seedkernel-wasm/platform";
import { hostBlob } from "./host-blob.js";
// `writeOp` frames an app's own local op; `OpArgs` writes the transport bundle's op
// arguments, which is what the host's own door into the network takes (peers.js `net`).
import { writeOp, OpArgs } from "seedkernel-wasm/op-frame";
import { verifyBundle, genesisHash } from "seedkernel-wasm/bundle";
// The sockets: a WebSocket for the relay the transport meets and links peers through, and
// seedkernel's WebRTC seam for the peer connections it then moves them to (§12.7).
import { WsNetwork } from "seedkernel-wasm/net-ws";
import { RtcNetwork } from "seedkernel-wasm/net-rtc";
import { combineChannels } from "seedkernel-wasm/socket-seam";
// Who this page is linked to and why: the relay, its rooms, its contacts and the nicks
// (peers.js), which the shell with no page follows its peers through too.
import { Peers, ROOM_NAME_RE, friendlyRoom } from "./peers.js";
import { roomId } from "seedrelay/rooms";
// The shell's own code. media-rtc.js is the call feature: audio and video ride peer
// connections this page owns, signaled through the shell boot bundle below.
import { MediaCalls } from "./media-rtc.js";
// The contract with the apps this shell hosts: what it reads off a bundle, what it lets one
// reach, and the two ops it calls on an app's guest. Nothing in it, or in this file, knows
// what any one app does.
import { APP_GRANTS, APP_OP_CONTEXT, APP_OP_UI, MAX_QUEUED_RENDERS, admitGate, appFacts, bundleDigest, toHex, fromHex } from "./app-api.js";
// What keeps a view off the network: the page an app's view is loaded as.
import { guardView } from "./view-guard.js";
// The shell app: the page's own boot bundle, how this page talks to a peer's. What each
// tells the other about itself rides one of its claims, a call's signaling another, and an
// offer of an app the third.
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

// Surface a message on the Apps panel. Diagnostics still gets the full text
// via shellPrint; this is the part the user actually sees when they're not
// looking at the App-tab diagnostics drawer.
function showAppsNotice(text, kind = "err") {
  appsNotice.textContent = text;
  appsNotice.classList.remove("err", "ok");
  if (kind === "err" || kind === "ok") appsNotice.classList.add(kind);
  appsNotice.hidden = false;
  if (appsNoticeTimer) clearTimeout(appsNoticeTimer);
  appsNoticeTimer = setTimeout(() => { appsNotice.hidden = true; }, 6000);
  // Make sure the panel is visible — if the user dropped a file from the
  // App tab via the toolbar shortcut, surface the result where they'll see it.
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
  // Whatever its dot was for, a message or an offer, is seen now.
  tabs[name].btn.classList.remove("unread");
}
for (const [k, t] of Object.entries(tabs)) {
  t.btn.addEventListener("click", () => showTab(k));
}

aboutBtn.addEventListener("click", () => {
  aboutPanel.classList.toggle("open");
  aboutPanel.hidden = !aboutPanel.classList.contains("open");
});

/** The most lines Diagnostics keeps. A view whose calls fail and a peer whose frames are
 *  refused each print one, and neither should be able to make this page grow without end. */
const MAX_LOG_LINES = 500;

function shellPrint(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  shellLog.appendChild(line);
  while (shellLog.childElementCount > MAX_LOG_LINES) shellLog.firstElementChild.remove();
  shellLog.scrollTop = shellLog.scrollHeight;
}

/** 32 bytes as lowercase hex: a key or a contact secret. */
const HEX32_RE = /^[0-9a-f]{64}$/;

/** Run `act` when Enter is pressed in `field`, in place of what Enter would do there. */
function onEnter(field, act) {
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); act(); }
  });
}

/** What `field` holds as 32 bytes of hex: the bytes, null for an empty field, or undefined
 *  for anything else, which the field is then marked with, saying `why`. A mark goes as
 *  soon as the field is typed in (`hexField`). */
function readHex32(field, why) {
  const typed = field.value.trim().toLowerCase();
  if (typed === "") return null;
  if (HEX32_RE.test(typed)) return fromHex(typed);
  field.setCustomValidity(why);
  field.reportValidity();
  return undefined;
}

/** A field that takes 32 bytes of hex, `act` run by Enter in it. */
function hexField(field, act) {
  field.addEventListener("input", () => field.setCustomValidity(""));
  onEnter(field, act);
}

/** A small button, as every list here has them. */
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
// The host blob (host-blob.js): the realm engine every guest runs on, and the host's
// crypto, libsodium and ML-DSA-65, which run on WebAssembly here as on every seedkernel
// target. Its `sodium` is the page's too, ready before anything below touches it:
// verifyBundle needs the PQ signature half for ANY bundle, and it is synchronous.
//
// This runtime only VERIFIES suite 0x02 bundle envelopes (§12.4, §14.1). Bundle
// authoring is offline and lives behind seedkernel-wasm/bundle-author, which is not
// shipped in the browser runtime tree.
const host = platformHost(browserPlatform({ hostBlob: await hostBlob }));
const sodium = host.sodium;

// Ongoing-consent admission (§12.4): the user approves each unique bundle before it
// runs. `pendingApprovals` holds the digests of the bundles the user has consented to
// (`bundleDigest`, app-api.js: the whole bundle, guest included); the shell's `admit`
// callback consumes one (one-shot) on install. The shell runs under an open policy, so
// consent — not a static author allow-list — is this shell's gate.
const pendingApprovals = new Set();
/** The one system hash (seedkernel's BLAKE2b-256), with its crypto bound. */
const digest = (bytes) => genesisHash(sodium, bytes);
// The notices peers are owed, by key in hex: true for one this node added, false for one
// it removed. Each is sent once its peer is linked (`tellPeers`).
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
//
// What a room, a contact and a contact secret are is peers.js's. `myContactSecret` is this
// node's, or null, kept with the identity, as the contacts and the rooms are.
const savedContact = sessionStorage.getItem("shell.contactSecret");
let myContactSecret = savedContact && HEX32_RE.test(savedContact) ? fromHex(savedContact) : null;

// The tab's sockets, standing before the transport: the assembly registers its accept sink
// while starting it, and RtcNetwork announces every data channel through that sink. The
// transport itself opens the relay (a WebSocket), links through it, and drives the peer
// connections.
const net = combineChannels(new WsNetwork(), new RtcNetwork());

// Assemble the shared shell now that the identity exists — via the host's `standUp`, the
// ONE assembly (§12.8, §12.9). The browser platform supplies the host blob's crypto and
// realm engine, private modules in workers, and an in-memory store and freshness marks;
// the page adds its identity and the channel adapter, which the assembly CONSTRUCTS from
// the `transport` options (identity taken from the top-level fields, never restated) and
// returns with the shell. The adapter is the platform's: link ids and sockets, the ones
// above passed in as `channels`. Raw-link events then go only to whichever admitted slot
// owns the `link` binding, and `shell.close()` closes the whole stack. Transport policy
// belongs to the signed bundle, and so does the address book, in that bundle's own realm
// (§12.10).
//
// `standUp` builds the rest of the node's options itself (the crypto, store, modules and
// realm engine are the platform's) and takes from the page only the fields
// below — `dir`, `identity`, `admit`, `transport`, `guestDeadlineMs` and
// `realmMemoryBytes` (seedkernel's `NodeSetup`). Anything else passed here is dropped.
//
// This node's contact secret is the transport's config here, so the gate stands before
// anything can call, and `setMyContact` changes it later with the guest's `contact` op.
// Who is linked follows the rooms and contacts (peers.js), a peer at a time, without
// reloading the transport.
//
// The page serves no name of its own: dispatch is a single claim → bundle slot map
// (seedkernel §12.10), and there is no owner but a signed bundle. `admit` is ONE predicate
// (§12.5), and it composes two things that are actually the page's: the shell boot
// bundle's author+app pin (deployment-shipped bytes, not a consent prompt) and the
// user-consent gate for every other app. The transport never reaches this gate: the
// assembly installs it by selection (§12.5).
const { shell } = await host.standUp({
  // Where the store keeps this node's files, in the platform's memory.
  dir: "shell",
  identity: myKeys,
  // A room keeps its members linked, so links do not idle out; the page redials a member
  // whose link drops (peers.js `follow`).
  transport: {
    channels: net,
    onStatus: (status) => onStatus(status),
    config: { linkIdleTimeoutMs: 0, ...(myContactSecret ? { contactSecret: toHex(myContactSecret) } : {}) },
  },
  // The shell app is pinned: the exact author and app this PAGE was built with
  // (browser/shell-bundle.js, which scripts/build-app-bundle.mjs writes), read off the
  // artifact rather than restated by hand. Every other bundle is an app the user consented
  // to, named by the digest of all of it: a consent to one guest admits no other beside the
  // same module (`admitGate`, app-api.js).
  admit: admitGate([{ author: SHELL_AUTHOR_HEX, app: SHELL_APP }], pendingApprovals, digest),
});

// Who this page is linked to and why (peers.js). What it shows of them is drawn again each
// time that may have changed (`followPeers`), and the rooms each time who is in them has.
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
//
// What this page says to a peer's rides the node's own authenticated channel, under the
// three claims the shell boot bundle holds (shell-app.js). A peer's frame reaches the page
// as that load's `onInbound` answer, attributed by the channel it arrived on and told apart
// by the claim it arrived under; ours leave through the same app's three ops, since only a
// guest can reach `_net`.
//
//   shell/v1   what a page tells another about itself (`onPageNotice`): `{ peer: true }`
//              from a page that added this node as a peer and `{ peer: false }` from one
//              that removed it, and `{ nick }`, what a peer calls itself.
//   call/v1    a call's signaling. Its audio and video ride peer connections this page owns
//              (media-rtc.js), beside the transport's.
//   offer/v1   an app a peer offers (`handleOffer`), a signed bundle.
const shellApp = await shell.install(shellBundleBytes(), {
  onInbound: (claim, from, answer) => {
    if (answer.length === 0) return;
    if (claim === CALL_PROTO) void media.onSignal(toHex(from), answer);
    else if (claim === OFFER_PROTO) handleOffer(answer, toHex(from));
    else onPageNotice(toHex(from), answer);
  },
});

/** Hand `bytes` to a peer's page through one of the shell app's three ops, each of which
 *  sends under one of its protocols. */
function sendPage(op, peerId, bytes) {
  const arg = new Uint8Array(32 + bytes.length);
  arg.set(fromHex(peerId), 0);
  arg.set(bytes, 32);
  return shellApp.invoke(writeOp(op, arg));
}

/** Tell a peer's page something about this one, under shell/v1: whether that page got it. */
async function tellPage(peerId, notice) {
  return (await sendPage(SHELL_OP_TELL, peerId, notice))[0] === 1;
}

/** What a peer's page tells this one about itself, already attributed by the channel it
 *  arrived on. A peer that added this node is added here too, and one that removed it is
 *  removed, so the two ends agree on being peers. */
function onPageNotice(from, bytes) {
  let msg;
  try { msg = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  // What the peer calls itself, an empty nick for nothing: shown in place of its key, by
  // this page and by every app.
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
  // A call's peer connections ask the STUN the transport's do (seedkernel §12.7), the relay
  // the peer is reached through, so no third party learns who is calling.
  iceServers: (peerId) => peers.ice(peerId),
  send: (peerId, signal) => sendPage(SHELL_OP_SIGNAL, peerId, signal),
  onCallers: () => callersChanged(),
  onPeerClosed: (peerId) => {
    removeRemoteTile(peerId);
    updateCallStatus();
  },
  onTrack: (peerId, track) => {
    const tile = getOrCreateRemoteTile(peerId);
    // A track its peer turned off and on again is announced again.
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

// ─── channel identity ──────────────────────────────────────────────────
//
// Transport identity is the transport bundle's job. Each data channel runs its
// in-channel HELLO/AUTH challenge (§12.6), proving the far end holds the node
// private key for the pubkey it claims — a continuous channel binding, which
// subsumes both SDP a=fingerprint signing and any per-message signature.
// A frame reaches an app's guest already attributed to an authenticated peer: the
// host puts the sender's pubkey in front of it, and that key is authoritative.
// There is no envelope signer to verify.

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

// What the transport tells the page (`onStatus`, peers.js `status`): the relay's state, who
// is linked and how each is reached, each time any of it changes: the relay's state
// (`showRelay`), and each linked peer's key with whether its link has moved off the relay
// to WebRTC (seedkernel §12.7). So the page hears of a change as it happens, and asks
// nothing.
function onStatus(status) {
  peers.status(status);
  showRelay();
}

// The pill counts the linked peers, and says how many of them the relay still forwards:
// green once every link is direct, amber while any is relayed.
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

// The Network tab's peer list: the peers this node is connected to directly, by key. That
// is one row for every contact, linked or not, and for any linked peer in none of its
// rooms, which is one that called this node directly. A room-mate that is neither is in
// its room's list instead (`renderRoomList`). A row names the peer, by its nick if it has
// told one, and says how it is reached, or how the call to it stands. A contact with
// no link takes its contact secret: the row's Connect calls it presenting what the field
// holds. Rows are kept and changed in place, never redrawn, so a field being typed in
// survives the list being drawn again.
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
    // After the empty row, in key order. A row already in place is not moved, which
    // would take the focus from its field.
    if (peerListEl.children[i + 1] !== row.li) peerListEl.insertBefore(row.li, peerListEl.children[i + 1] ?? null);
    const isLinked = linked.has(id), isContact = contacts.has(id);
    const label = peers.label(id);
    const state = isLinked ? (linked.get(id) ? "direct" : "relayed") : wanted.get(id).silent ? "silent" : "calling";
    const shown = `${state} ${isContact} ${label}`;
    if (shown === row.shown) return;
    // The field holds what this node presents to the contact, shown again each time the
    // row comes to need it.
    const asks = isContact && !isLinked;
    if (asks && row.secret.hidden) row.secret.value = contacts.get(id) ? toHex(contacts.get(id)) : "";
    row.secret.hidden = row.connect.hidden = !asks;
    row.name.textContent = label;
    // A contact is removed here; one is added from a room's list, or by its link or key.
    row.remove.hidden = !isContact;
    row.shown = shown;
    row.state.className = `peer-route ${state}`;
    [row.state.textContent, row.state.title] = PEER_STATES[state];
  });
}

// ─── app registry ──────────────────────────────────────────────────────
//
// An "app" is an ordinary signed bundle (§12.4): a signed manifest, the app's guest
// program and its WASM modules in one blob. That blob IS the bundle format — the same
// bytes seedstore's flagship deployment loads from disk, so an app here needs no install
// format of its own. The shell's `install` (the shared install path) authenticates the
// author's signatures over the whole body, so the blob survives any number of transitive
// relays and still authenticates against its original author — exactly the
// store-and-forward property an Offer needs. The local "add app" flow and the
// peer-to-peer Offer below carry the identical bundle.
//
// What this shell READS of an app is in its signed manifest (`appFacts`, app-api.js): its
// name and version for a row, the protocols it claims and what it reaches for the consent
// that row asks, and its view, an HTML page. The manifest's `app` is the label, and it is
// also the key the app lands under (seedkernel §12.4): one slot per label on a node,
// whoever authored it.
//
// What an app DOES is its guest's, and the shell never reads it. Three things reach a
// guest, each as bytes: a peer's frame under a protocol the app claims, with the sender
// the channel authenticated in front; the node's context; and whatever the app's own view
// sent. Each answer goes to the view: render bytes, or the answer to the view's own call.
// So the format of a frame, of a render and of what a view asks its guest are all the
// app's own, and an app changes them by shipping a new bundle, with nothing here to change
// beside it.
//
// The key is node-local. Two peers need not agree on it: a frame carries a *protocol
// id*, and each side resolves that to whichever app it installed that claims it — so two
// peers running different authors' apps interoperate as long as both speak the protocol.
//
// `installedApps` keeps the per-app state: the handle into its guest, its view, and the
// packed bundle (`bundleBytes` is the signed blob — the author's manifest signature
// intact — and is what every "Offer" hands to a peer). Apps received via Offer keep the
// original author's signature: we never re-sign a bundle.
// Keyed by the app label — the key the host installs a slot under (§12.4). A node holds
// one slot per label, so two authors' apps under one label contend for it: the second
// lands only by replacing the first.
const installedApps = new Map();   // app label → AppRecord
// The app shown in the App tab, by label, or null. Every installed app runs; this is only
// whose view is in front.
let activeAppKey = null;

// Protocol routing (§12.10) — there is no table here and no bind button. A bundle's
// manifest CLAIMS its protocols, and the load that admits it is what routes each id to
// it. A claim has one holder, so an app claiming an id another app holds lands only by
// replacing it. `shell.resolve` answers who holds one; the Apps panel reads the claim off
// the manifest rather than storing anything.

const STORE = "apps.v3";

// ── an app's guest ──────────────────────────────────────────────────────
//
// The shell's two ops into a guest (app-api.js), and nothing else: `ctx`, the node's
// context, and `ui`, bytes from the app's own view. Messages ride the Transport request
// plane under the protocol the app claims, and reach the guest without the shell seeing
// them; there is no app-specific framing here at all.

/** One local op into `rec`'s guest: the install's handle loops back through `handle`,
 *  with the host's caller id in front of the op, framed by seedkernel's op-frame. The op
 *  NAME is the contract's; the bytes behind it are the app's. */
function invokeApp(rec, op, bytes) {
  return rec.invoke(writeOp(op, bytes));
}

/** Tell one app's guest the node's context as it now stands (peers.js `context`: who this
 *  node is and what it calls itself, its rooms and who the relay says is in each, the
 *  linked peers, the contacts, and what each peer calls itself; none of it a secret), and
 *  answer what the guest answered, render bytes for its view, or nothing. */
async function tellContext(rec) {
  const json = rec.ctx = peers.context();
  try { return await invokeApp(rec, APP_OP_CONTEXT, new TextEncoder().encode(json)); }
  catch (err) { shellPrint(`${rec.name}: ${err.message}`, "err"); return new Uint8Array(0); }
}

/** Tell every app whose guest has not heard the context as it now stands, and hand its view
 *  the answer. Called wherever it may have changed: a room joined or left, a member heard, a
 *  contact added, a peer linked, a nick told. A guest is told once per change, however often
 *  this is called. */
function postContext() {
  const json = peers.context();
  for (const rec of installedApps.values()) {
    if (rec.ctx !== json) void tellContext(rec).then((answer) => deliverRender(rec, answer, { isContext: true }));
  }
}

// ── an app's view ───────────────────────────────────────────────────────
//
// A view is the app's own HTML page in a sandboxed iframe, loaded from a `blob:` URL: an
// opaque origin with no access to this page's DOM or keys, which reaches the shell only by
// postMessage. Each installed app has its own, made when the app is installed and kept
// until it is removed or replaced. The app shown is the one whose frame is in front; one
// that is not still hears from its guest, so its view is current when it is opened.
//
// The sandbox keeps a view from this page, and `guardView` (view-guard.js) keeps it from
// the network: the page loaded is the author's with a policy of its own in front, under
// which it makes no request and has no WebRTC. So what a view is shown goes nowhere but
// back through its guest, which reaches what the app's consent row said.
//
// allow-forms lets a view use a normal <form> element for its input. A view still
// preventDefault()s in its submit handler so no actual navigation happens; the null
// sandbox origin contains anything the form could attempt regardless.
//
// allow-downloads lets a view hand the user a file it has put together, as a link to a
// blob of its own: jam saves a track that way. A file is all it is. The view still reads
// and writes nothing on disk, and the browser shows a download like any other.

function mountView(rec) {
  if (!rec.ui) return;
  // The parent page's frame-src blob: (shell.html) is what stops a view navigating itself
  // to a server; guardView's own frame-src only governs frames the view makes. Keep it.
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

/** Hand an app's view the render bytes its guest answered, to a peer's frame or to the
 *  context. The shell does not read them. What a guest answers its view's own `call` is
 *  not a render: it goes back to that call (below).
 *
 *  Renders that arrive before the view says "ready" are queued, so an app just installed
 *  does not drop its first message. A context answer is not: `viewReady` gives the view
 *  the context as it then stands, ahead of the queue, and an older one behind it would
 *  put the view back. `fromPeer` is an answer to a peer's frame, which is what the App
 *  tab's unread dot is for when the user is looking at another tab. */
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

/** A view said it is ready. Its guest is told the context, and the view is handed that
 *  answer first and then what arrived while it loaded, in order: a message is drawn by a
 *  view that already knows the room it is in. */
async function viewReady(rec) {
  const frame = rec.frame;
  const context = await tellContext(rec);
  if (!frame || rec.frame !== frame) return; // removed or replaced meanwhile
  rec.ready = true;
  for (const payload of [context, ...rec.queue.splice(0)]) {
    if (payload.length > 0) postRender(frame, payload);
  }
}

/** Post one render to a view. It is copied, not handed over: an answer to a peer's frame is
 *  also what the transport answers that peer with. */
function postRender(frame, payload) {
  frame.contentWindow.postMessage({ type: "render", payload }, "*");
}

// ── reading a bundle ────────────────────────────────────────────────────
//
// Read an app's facts off a bundle for the UI and the consent gate, through the shared
// §12.4 verify path: both signatures authenticate the entire body before its manifest is
// read. Throws, saying why, for anything malformed, unauthentic, or not an app this shell
// runs (`appFacts`). That check is what keeps an Offer from installing authority behind a
// consent row: `guest.requires` is where a bundle's reach is written down, and this is the
// one place on the install path that reads it.
function peekBundle(bundleBytes) {
  let v;
  try { v = verifyBundle(sodium, bundleBytes); }
  catch { throw new Error("not a valid app bundle (.skb)"); }
  return {
    // The label it installs under (§12.4), a fact of the signed manifest, so the page has it
    // BEFORE the install.
    key: v.manifest.app,
    authorPk: v.author.slice(),
    // What a consent to this bundle names, and what tells two bundles apart.
    hash: toHex(bundleDigest(v, digest)),
    ...appFacts(v.manifest),
  };
}

// Install a bundle the user has consented to: by dropping it, by accepting its offer, or
// by having installed it before a reload. Calls the shared §12.4 installer, which
// verifies the bundle signatures, checks the admit gate, and stands the slot. Returns the
// AppRecord. `peeked` is what `peekBundle` read of it, for a bundle already read.
async function applyAppBundle(bundleBytes, peeked = peekBundle(bundleBytes)) {
  const { key } = peeked;
  // Taking a standing label over takes its data and signing scope with it. The app's own
  // author shipping its next version is the one-click upgrade; a different author's
  // bundle under the same label is asked about by name.
  const standing = installedApps.get(key);
  if (standing && toHex(standing.authorPk) !== toHex(peeked.authorPk)
      && !confirm(`Replace ${standing.name} ${standing.version} with ${peeked.name} ${peeked.version} ` +
        `by a different author (${toHex(peeked.authorPk).slice(0, 12)}…)?`)) {
    throw new Error("replacing an app from a different author was declined");
  }

  const record = {
    // What its row shows and its view is: the manifest's facts, its signed claim (§12.10)
    // and reach (§12.2) among them.
    ...peeked,
    bundleBytes,
    /** The install's handle — the one loopback `invoke`, bound to this app's slot. */
    invoke: null,
    // Its view: the frame, whether it has said it is ready, and the renders held until then.
    frame: null,
    blobUrl: null,
    ready: false,
    queue: [],
    /** The context its guest was last told, as JSON. */
    ctx: null,
    /** The conversation its view says is open, `{ room }` or `{ to }` by id in hex, null
     *  for none, and undefined for a view that never says. */
    conv: undefined,
  };

  // The consent is one-shot (`admit`), and withdrawn if the install does not take it.
  pendingApprovals.add(peeked.hash);
  let loaded;
  try {
    loaded = await shell.install(bundleBytes, {
      // Naming no predecessor takes a FREE label and refuses a standing one (§12.4), so a
      // bundle under a label already here — an app's next version, or another author's
      // app — says which slot it retires. The user's app row IS that question, and it is
      // all that separates a first install here from an upgrade.
      replaces: standing ? key : undefined,
      // Protocol routing (seedkernel §12.10): the render bytes ARE this app's own answer
      // to the frame it just served, and the installer that mounted it receives them
      // right here, off its own install — no second claim, and no 32-byte comparison
      // against a caller id, because the page already knows which app THIS install is.
      onInbound: (claim, from, answer) => deliverRender(record, answer, { fromPeer: true }),
    });
  } finally {
    pendingApprovals.delete(peeked.hash);
  }
  record.invoke = (arg) => loaded.invoke(arg);

  if (standing) unmountView(standing);
  installedApps.set(key, record);
  mountView(record);
  // Its guest starts with no context: tell it, without waiting for its view to load.
  postContext();
  keepApp(record);
  renderAppList();
  return record;
}

// ── persistence ────────────────────────────────────────────────────────
// The packed bundle is the only piece of app state we need — the installed app and its
// view both derive from it. We keep them in sessionStorage so a reload within the same
// tab keeps the user's app set and lets transitive offers continue to work: each bundle
// under its label, as base64, written when it is installed and removed with it, and beside
// them the labels in the order they were installed, and the app shown. Nothing else to
// keep: the routing is a projection of the installed manifests (§12.10), so the bundles
// ARE it, with no second store to fall out of step.
const appKey = (label) => `${STORE}.app.${label}`;
const appOrder = () => {
  try { return JSON.parse(sessionStorage.getItem(`${STORE}.order`) ?? "[]"); } catch { return []; }
};

/** Bytes as base64, which a session store holds at 4 characters to 3 bytes. */
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Keep `rec` for a reload. One the store has no room for is said, and runs until then. */
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
  // Read before the replay, which installs with no app shown yet.
  const saved = sessionStorage.getItem(`${STORE}.active`);
  // Replaying the bundles in the order they were installed reproduces the routing exactly:
  // each one lands on its own label and claims exactly what its manifest names, and a
  // contest with an already-restored app is refused rather than resolved by order
  // (§12.10). A restored app cleared the consent gate when it was installed, which is the
  // consent `applyAppBundle` installs it under.
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
// An offer is a packed app bundle forwarded over a data channel on `offer/v1`, a claim of
// the shell boot bundle's (shell-app.js), since the app that would take it is the thing
// being offered. Any peer who holds the bundle can forward it (transitive offer), and the
// bundle carries the original author's signatures over all of it, so the recipient still
// authenticates against the author (peekBundle verifies it).
//
// The relaying peer is identified by the AKE channel, not a signature — the frame is
// unsigned; the bundle's own manifest signature is the load-bearing authentication.
//
// An offer waits here, by the digest a consent to it would name, until it is accepted or
// dismissed, or the page goes: what is waiting is this page's, and no store keeps it.
const pendingOffers = new Map();   // bundle digest → { bundleBytes, peeked, fromPkHex }

/** The most offers one peer has waiting here. An offer costs a peer one frame, so what is
 *  waiting is bounded where it is held. */
const MAX_OFFERS_PER_PEER = 8;

function handleOffer(bundleBytes, fromPkHex) {
  let peeked;
  try { peeked = peekBundle(bundleBytes); }
  catch (err) {
    shellPrint(`Offer from ${fromPkHex.slice(0, 8)} dropped: ${err.message}`, "err");
    return;
  }
  // Already running this exact bundle, or already offered it: nothing to offer. An update
  // differs somewhere, in its guest or a module or its view, so its digest differs and it
  // still surfaces for consent (installs are consent-gated, §12.4).
  if (pendingOffers.has(peeked.hash) || [...installedApps.values()].some((rec) => rec.hash === peeked.hash)) return;
  if ([...pendingOffers.values()].filter((o) => o.fromPkHex === fromPkHex).length >= MAX_OFFERS_PER_PEER) {
    shellPrint(`Offer from ${fromPkHex.slice(0, 8)} dropped: it has ${MAX_OFFERS_PER_PEER} waiting here already`, "err");
    return;
  }
  pendingOffers.set(peeked.hash, { bundleBytes, peeked, fromPkHex });
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
//
// Every outbound frame leaves through a guest, because that is the only thing that can
// send: the host's driver holds sockets and no request face at all, and the network is
// the transport, reached by calling the id it claims (§12.10). An app's own frames leave
// through its own guest, and the shell never sees them. The shell's own leave through its
// boot bundle (`sendPage`): what it tells a peer's page, a call's signals and an Offer. No
// app's guest is borrowed to carry any of them.

// Send the stored bundle for `key` to every linked peer, all at once. Anyone who receives
// this can forward it to others — that's transitivity for free.
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
//
// An installed app's row and an offered one's are the same row, with different buttons:
// both say what the bundle is and, the part a consent rests on, what it serves and what
// it reaches. `app` is the facts `peekBundle` read off the signed manifest, which an
// AppRecord carries too.

/** The top of a row: the app's name, version and description, as its author wrote them. */
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

/** One line of `label value` pairs, a dot between them. */
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

/** What a bundle SERVES (§12.10) and what it REACHES (§12.2) — read, never set. Both are
 *  the manifest's signed word. The protocols are its claim, and installing it is what
 *  routes each to it; `guest.requires` is the whole of what its guest can touch, so on an
 *  offer's row this line is what the Install button grants. */
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

/** A row for an app, installed or offered: what it is, from whom if it was offered, and its
 *  buttons, each `[label, class, onClick, disabled]`. */
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

/** The row a list shows while it has nothing in it. */
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
  // Revocation (§12.5): uninstall drops the slot this label names — the protocols it
  // claimed and its guest realm.
  shell.uninstall(key);
  installedApps.delete(key);
  unmountView(rec);
  if (activeAppKey === key) showNoApp();
  forgetApp(key);
  renderAppList();
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
  // Dropping a file IS the consent (§12.4), granted to whatever already-signed bundle
  // the user picked. One this shell will not run is refused here, with the reason.
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
//
// The view's half of the contract (app-api.js). `ready` and `call` are about its own app:
// the shell passes bytes between a view and its guest and reads none of them. The other
// two ask something of the shell, about things that are the shell's, a room or a peer
// named by its id in hex: `conv` and `contact`. A view is any author's page, so each is
// checked for shape, and neither of those two hands it anything back.

/** Whether `v` is 32 bytes as lowercase hex: a key, or a room's id. */
const isHex32 = (v) => typeof v === "string" && HEX32_RE.test(v);

window.addEventListener("message", (ev) => {
  const rec = [...installedApps.values()].find((r) => r.frame && r.frame.contentWindow === ev.source);
  const msg = ev.data;
  if (!rec || !msg) return;

  if (msg.type === "ready") { void viewReady(rec); return; }

  // Bytes for the app's own guest. Every call is answered, under the id the view gave it:
  // with what the guest answered, empty or not, or with why it failed. So a view can ask
  // its guest something and wait, and one whose guest threw is not left waiting.
  if (msg.type === "call") {
    if (!(msg.bytes instanceof Uint8Array) || !Number.isSafeInteger(msg.id)) return;
    // To the view that asked, if it is still there: the app may be gone by the answer. The
    // answer is this call's alone, so its bytes are handed over rather than copied.
    const answer = (fields, transfer = []) => rec.frame?.contentWindow.postMessage({ type: "answer", id: msg.id, ...fields }, "*", transfer);
    invokeApp(rec, APP_OP_UI, msg.bytes).then((payload) => answer({ payload }, ownsBuffer(payload) ? [payload.buffer] : []), (err) => {
      shellPrint(`${rec.name}: ${err.message}`, "err");
      answer({ error: err.message });
    });
    return;
  }

  // The conversation open in the view: a room, one peer, or none. A call started now is
  // with it (`callPeers`).
  if (msg.type === "conv") {
    rec.conv = isHex32(msg.room) ? { room: msg.room } : isHex32(msg.to) ? { to: msg.to } : null;
    // The call bar names who a call would ring, which just changed.
    updateCallStatus();
    return;
  }

  // Make a peer a contact, so the link to it outlives any shared room: what a view asks
  // before it writes to one peer directly. Only of a peer this node already knows, one it
  // shares a room with or is linked to, which are the peers a view is told of. A contact is
  // a key this node calls, wherever it is, and is told so; so a view that could name any
  // key could have this node link to one its user never met, and its guest then write to
  // it. A key from anywhere else is added by the user, on the Network tab.
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

/** Whether `bytes` is the whole of its buffer, so handing the buffer over hands nothing else. */
const ownsBuffer = (bytes) => bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;

// ---------------------------------------------------------------------------
// Networking: the page meets peers in a relay room; the transport bundle links to them
// through the relay and moves each link to WebRTC.
//
// The transport is the seedkernel-shipped signed bundle the assembly installed: the channel
// AKE, record layer, link routing and request/response layer run as its confined guest
// program, driven by the shell's TransportHost, and so do the relay registration, the
// links through the relay, the move to WebRTC (signaled over the peer's authenticated
// link) and who offers; a WebRTC link that is lost is dialed again through the relay
// (§12.7). What net-rtc.ts contributes is the platform object: it holds each
// RTCPeerConnection and passes its negotiation through as bytes. Channel identity is the
// transport's in-channel HELLO/AUTH (§12.6), so a frame reaches a guest already attributed
// to an authenticated peer: the key the host puts in front of it is its author. No
// per-message signature.
//
// Who is wanted, and the links to them, are peers.js's. What is the page's alone is below:
// what it draws, what it keeps for a reload, and what it tells a peer's page of being its
// peer. `relaySecret` is a private relay's (seedrelay's `--secret`), or null for an open
// one: the relay operator's credential, so it never rides in a link that is shared.
// ---------------------------------------------------------------------------

// A nick is the shell's, not an app's: what this node calls itself, set on the Network
// tab, and what each peer calls itself. The pages tell each other on their own channel
// (`{ nick }` on shell/v1, `onPageNotice`), so a name is the same in every app and needs
// none installed, and every app reads it out of its context.

/** Set this node's nick, or with "" have none. Every peer is told again, and the apps hear
 *  of it in their context. */
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

/** Make `key` a contact, with its contact secret or null: linked whether or not a room is
 *  shared. A new one is told, once it is linked, so it is this node's peer at both ends;
 *  `tell: false` is for one that said so itself. */
function addContact(key, secret, { tell = true } = {}) {
  if (key === myPkHex) return;
  if (!peers.contacts.has(key)) {
    if (tell) untoldPeers.set(key, true); else untoldPeers.delete(key);
  }
  peers.addContact(key, secret);
  saveContacts();
  renderRoomList();
}

/** Stop `key` being a contact, and tell it, unless it said so itself. */
function removeContact(key, { tell = true } = {}) {
  const before = [...peers.wanted.keys()];
  // One never told it was added has nothing to hear.
  const knows = untoldPeers.get(key) !== true;
  untoldPeers.delete(key);
  peers.removeContact(key);
  saveContacts();
  renderRoomList();
  if (!tell || !knows) { peers.hangUpUnwanted(before); return; }
  void tellRemoved(key, before);
}

/** The notice one page sends another: it added it as a peer, or removed it. */
const peerNotice = (added) => new TextEncoder().encode(JSON.stringify({ peer: added }));

/** Tell `key` this node removed it, then hang up on those of `before` no longer wanted: a
 *  link the transport closes still carries what was sent on it first (seedkernel §12.6).
 *  One with no link is owed the notice until it has one (`tellPeers`): a send would dial
 *  it. */
async function tellRemoved(key, before) {
  let told = false;
  try {
    if (peers.linked.has(key)) told = await tellPage(key, peerNotice(false));
  } catch { /* not told: owed, below */ }
  if (!told && !peers.contacts.has(key)) untoldPeers.set(key, false);
  peers.hangUpUnwanted(before);
}

/** Send each linked peer the notice it is owed: that this node added it, or removed it. */
function tellPeers() {
  for (const [key, added] of [...untoldPeers]) {
    if (!peers.linked.has(key)) continue;
    untoldPeers.delete(key);
    const told = tellPage(key, peerNotice(added)).catch(() => {});
    // A removed peer that linked again, still listing this node: it is told, and hung up on.
    if (!added) void told.then(() => peers.hangUpUnwanted([key]));
  }
}

/** A contact row's Connect, and a contact given again: call `key` afresh, presenting
 *  `secret`, or none. */
function recontact(key, secret) {
  peers.callAfresh(key);
  addContact(key, secret);
}

/** A contact row's Connect: what its field holds is the contact secret to present. */
function connectPeer(key, field) {
  const secret = readHex32(field, "A contact secret is 64 hex characters.");
  if (secret !== undefined) recontact(key, secret);
}

/** Set this node's own contact secret, or with null open it to any caller (§12.6.3). Links
 *  already up stay, and room-mates are answered either way. */
async function setMyContact(secret) {
  await peers.net(new OpArgs("contact").blob(secret ?? new Uint8Array(0)));
  myContactSecret = secret;
  if (secret) sessionStorage.setItem("shell.contactSecret", toHex(secret));
  else sessionStorage.removeItem("shell.contactSecret");
  updateContactHint();
}

// Boot the app registry now that the shell exists: render the (empty) lists, then pull
// back anything installed earlier this session so a transitive Offer works the moment
// peers connect, from the saved signed bytes.
renderAppList();
renderOfferList();
restoreInstalledApps().catch((err) =>
  shellPrint(`Restore failed: ${err.message}`, "err"));

// ─── live audio/video calls ────────────────────────────────────────────
//
// Calls ride peer connections of their own, one per peer in the call, through MediaCalls
// (./media-rtc.js), signaled over the shell boot bundle. A call is with the conversation
// open in the app when it starts: its linked peers, a room's members or one peer, are told
// of it, and followPeers keeps that following them (`callPeers`). Being told is all a
// peer gets: the bar says who is calling, and nothing of the call is received, or sent,
// until it is accepted there (`incomingCall`). Whoever enters a call does so with the
// microphone and the camera on, each then turned off and on by its own button (`capture`,
// `release`); endCall hangs up with every peer. Remote tracks arrive via the onTrack
// callback wired on `media` above and land in a per-peer tile keyed by pubkey hex; a tile
// is cleaned up when its track ends or its media connection closes.
//
// All of it is here rather than in an app's view because a view cannot capture: its
// sandbox gives it an opaque origin, and `getUserMedia` fails there with a SecurityError
// whatever the iframe's `allow` says.

const callBar      = document.getElementById("call-bar");
const callStartBtn = document.getElementById("call-start");
const callDeclineBtn = document.getElementById("call-decline");
const callMuteBtn  = document.getElementById("call-mute");
const callCamBtn   = document.getElementById("call-cam");
const callEndBtn   = document.getElementById("call-end");
const callStatus   = document.getElementById("call-status");
const videoTiles   = document.getElementById("video-tiles");

// What we have captured for the call in progress: the microphone and the camera, less
// whichever is off or the browser did not give, and null out of a call.
let localStream = null;
const remoteTiles = new Map(); // pkHex -> { wrap, video, stream }
// The conversation the call in progress is with: what the app shown said was open when the
// call started (its record's `conv`), `{ room }` or `{ to }` by id in hex, null for none,
// and undefined for an app that never says, or with no app shown.
let callScope;

/** The linked peers, by key in hex. */
const linkedKeys = () => [...peers.linked.keys()];

/** Who the relay says is in the joined room with this id; nobody for a room not joined. */
const membersOf = (id) => peers.roomById(id)?.[1].members ?? new Set();

/** Who of the linked peers a call with `scope` is with: a room's members, or one peer. A
 *  call from an app that never says which conversation is open is with everyone linked. */
function peersIn(scope, linked) {
  if (scope === undefined) return linked;
  if (scope === null) return [];
  if (scope.to) return linked.filter((p) => p === scope.to);
  const members = membersOf(scope.room);
  return linked.filter((p) => members.has(p));
}

/** Who of the linked peers the call in progress is with. */
const callPeers = (linked) => peersIn(callScope, linked);

/** Who a call with `scope` rings, in the shell's own words. Which conversation is open is
 *  the view's word (`conv`), and it is the user's camera and microphone that go there: so
 *  the call bar says who that is, and the user need not take it from the view as well. */
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

/** What both ends of a call with `scope` name it by: a room's id, "direct" for a call with
 *  one peer, "all" for one with everyone linked. */
const callName = (scope) => scope === undefined ? "all" : scope?.room ?? "direct";

/** What a call is turned down by, and kept from ringing again: a room's or everyone's by
 *  its name, one peer's by that peer. */
const callId = (peer, call) => call === "direct" ? peer : call;

// The calls turned down, or hung up on, by `callId`: none rings again while it lasts.
const declined = new Set();

/** The call waiting to be accepted: the first a peer says it is in that we could enter and
 *  have not turned down, as { id, scope, callers }, or null. A room's is one whose caller
 *  the relay says is in that room with us. */
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

/** Who is in a call changed: one nobody is in any more is not one turned down, so its
 *  next caller rings; and the bar says who is calling now. */
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
    // Who a call started now would ring, beside the button that starts it.
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

/** Draw a tile as its video, or as its label alone while it has none to show: no camera,
 *  or one its peer has turned off, which mutes the track here. */
function drawTile(wrap, stream) {
  const video = stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
  wrap.classList.toggle("no-video", !video);
}

/** A tile: `stream` as a video, with `label` under it. Our own plays muted. */
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

// Our own tile while in a call, and each peer's.
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

/** Start a call with the open conversation, or join the one it is in, with the microphone
 *  and the camera on. A call the browser gives neither to goes on with both off, each
 *  button then asking for its own. */
function startCall() {
  if (localStream) return;
  // A call waiting to be accepted is the one entered, whatever is open in the app.
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
  // Hung up on, the call does not ring here again for as long as others stay in it.
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

/** Turn the waiting call down: its callers are not told, and it rings here no more. */
function declineCall() {
  const ring = incomingCall();
  if (!ring) return;
  declined.add(ring.id);
  updateCallStatus();
}

/** The microphone and camera buttons, each reading what a click on it does, and our own
 *  tile, showing the camera while it is on. */
function showCapture() {
  const [mic] = localStream?.getAudioTracks() ?? [];
  const [cam] = localStream?.getVideoTracks() ?? [];
  callMuteBtn.textContent = mic?.enabled ? "Mute" : "Unmute";
  callCamBtn.textContent = cam ? "Stop video" : "Start video";
  if (localTile) drawTile(localTile.wrap, localStream);
}

/** Turn on the microphone (`audio`), the camera (`video`), or both in one asking: ask the
 *  browser for just that, and publish it to the peers in the call, and to any that enters
 *  it later. */
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
  // A hang-up while the browser was asking leaves no call to add it to.
  if (localStream !== stream) { for (const t of tracks) t.stop(); return; }
  if (what.audio) callMuteBtn.disabled = false;
  if (what.video) callCamBtn.disabled = false;
  for (const track of tracks) {
    // A device that goes away, unplugged or its permission withdrawn, ends its track.
    track.addEventListener("ended", () => release(track));
    stream.addTrack(track);
    media.publish(track, stream);
  }
  showCapture();
}

/** Let go of a captured track: stop sending it, and stop capturing it. */
function release(track) {
  if (!localStream?.getTracks().includes(track)) return;
  media.unpublish(track);
  track.stop();
  localStream.removeTrack(track);
  showCapture();
}

/** A mute only silences the microphone, which stays captured, so the unmute is at once.
 *  One the call never got is asked for here. */
function toggleMute() {
  if (!localStream) return;
  const [mic] = localStream.getAudioTracks();
  if (!mic) { void capture({ audio: true }); return; }
  mic.enabled = !mic.enabled;
  showCapture();
}

/** The camera is captured only while its video is on: stopping it lets the camera go. */
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
// Proactive ICE restart on a network change, for a call's media connections. ICE
// keepalives take 5–10s to notice a network flip on their own; kicking restartAllIce()
// the moment the browser tells us connectivity changed cuts straight to recovery. The
// transport restarts its own connections when they report `disconnected` (§12.7).
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

// The room joined when none is named: where two tabs on a laptop meet.
const DEFAULT_ROOM = "global";

// The relay's origin, and the room a URL typed with a path names (lets them paste a full
// `ws://host:8080/my-room` URL in just the URL field if they prefer).
function parseRelay(base) {
  let u;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
  return { origin: `${u.protocol}//${u.host}`, room: decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, "")) };
}

// The Connect under way or last made: the URL as it was typed, which a reload connects to
// again, and whether it is still under way. null after a Disconnect. Which relay and secret
// it is on are peers.js's (`peers.relay`).
let relayJoin = null;

/** Whether `room` is a name a room can have, saying so when it is not. */
function roomNameOk(room) {
  if (ROOM_NAME_RE.test(room)) return true;
  shellPrint("Room name must match [A-Za-z0-9._-] (up to 128 chars).", "err");
  return false;
}

/** "Connect": be on the relay in the URL field, where this node's key can be called and
 *  its contacts reached, and in the rooms already joined. No room is needed for it; a URL
 *  typed with a path joins the room it names. */
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

/** "Disconnect": be on no relay (peers.js `leaveRelay`). The rooms keep their names for the
 *  next Connect. */
async function disconnectRelay() {
  if (!peers.relay) return;
  relayJoin = null;
  relayShown = 0;
  const left = peers.leaveRelay();
  showRelayButton();
  // A reload stays off the relay too.
  sessionStorage.removeItem("shell.relayUrl");
  sessionStorage.removeItem("shell.relaySecret");
  await left;
  showRelayState(0);
  shellPrint("Disconnected from the relay.", "sys");
}

/** The relay button is the way out while this page is on a relay, or trying to be. */
function showRelayButton() {
  relayConnectBtn.textContent = peers.relay ? "Disconnect" : "Connect";
  relayConnectBtn.classList.toggle("primary", !peers.relay);
}

// The relay link is the transport's, which tells its state each time it changes
// (`onStatus`): 0 none joined, 1 registered, 2 dropped and redialing (seedkernel §12.6). It
// is shown only when it is not what is shown already, and not while a join is under way:
// that shows as connecting until it is over, registered or failed. A Connect shows the
// state it ends in whatever was shown before it (-1), and a Disconnect has shown none (0).
let relayShown = -1;
function showRelay() {
  if (peers.relayState === relayShown || relayJoin?.joining) return;
  relayShown = peers.relayState;
  showRelayState(peers.relayState);
}

/** The joined rooms in a few words, for the pill and the status line. */
function roomsLabel() {
  const names = [...peers.rooms.keys()].map(friendlyRoom);
  return names.length === 0 ? "no room" : names.length === 1 ? `room ${names[0]}` : `${names.length} rooms`;
}

/** Show the relay as connected: the pill names the rooms, or just says so with none. */
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
    // Remember the relay so a reload picks it, and the rooms, back up automatically.
    sessionStorage.setItem("shell.relayUrl", relayJoin.base);
    // The relay secret belongs to the relay, so it is saved and cleared with the relay.
    if (relaySecret) sessionStorage.setItem("shell.relaySecret", relaySecret);
    else sessionStorage.removeItem("shell.relaySecret");
  } else {
    relayStatus.textContent = "unreachable — retrying";
    setRelayPill("err", "relay down");
    // A private relay drops a node without its secret, which reads here as unreachable.
    shellPrint(`Relay unreachable — is one running at ${origin}, and if it is private, is the relay secret right? ` +
      "Retrying; existing P2P links are unaffected.", "err");
  }
}

/** "Join": be in the room typed, or the default one with none typed, beside any already
 *  joined. A page on no relay yet connects to the one in the URL field as well. */
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

// The Network tab's room list: each joined room with who else is in it, a link to share it
// by, and the way out of it.
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
    // Who they are, a line each under the room. One that is not a contact yet is made one
    // from here, and is then in the peer list.
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

// ── Links: a room to meet in, a contact to reach ─────────────────────────────
//
// A room link is `#room=<name>`. The name is all there is to a room, so whoever has the
// link can join it, and a room meant to stay private wants a name nobody can guess, which
// "Random" gives it. A contact link is `#pk=<key>` and, from a node with a contact secret,
// `&s=<secret>`: how to reach one node directly. Both ride in the URL fragment (`#`),
// which browsers never put on the wire, so the relay learns neither a room's name nor a
// secret from a link.

/** Read `room=<name>` and `pk=<64 hex>[&s=<64 hex>]` from a link, or from its fragment. */
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
/** This node's contact link: its key, and its contact secret when it has one. */
function contactLink() {
  const q = new URLSearchParams({ pk: myPkHex });
  if (myContactSecret) q.set("s", toHex(myContactSecret));
  return `${pageUrl()}#${q}`;
}

/** Say what this node's contact secret does, since a caller without it has no error path —
 *  it is simply a peer that never links. */
function updateContactHint() {
  contactHint.innerHTML = myContactSecret
    ? "Someone who is not in a room with you must present this node's <strong>contact secret</strong> " +
      "to connect. <strong>Copy contact link</strong> carries it, with your key."
    : "This node has <strong>no contact secret</strong>: anyone on the relay who has its key can connect. " +
      "Set one to answer only your room-mates and whoever you give it to.";
}

// "Random": a room nobody can guess. A room's name is all it takes to join it, so a private
// one wants 16 random bytes (seedrelay's README). They follow the name typed, which is how
// the room is shown. Lowercase hex so it round-trips through case-insensitive copy paths
// (URLs, chat clients) unchanged.
relayNewRoomBtn.addEventListener("click", () => {
  const name = friendlyRoom(relayRoomInput.value.trim()).slice(0, 95) || "room";
  relayRoomInput.value = `${name}-${toHex(sodium.randombytes_buf(16))}`;
  shellPrint("Private room name minted — press Join, then share its link.", "sys");
  relayRoomInput.focus();
});

/** Copy `text`, or failing that print it. Clipboard access can be denied or absent
 *  (file://, older browsers), so fall back to the shell log, where it can still be
 *  selected by hand — never leave the user with a button that silently does nothing. */
async function copyOrPrint(text, copied, what) {
  try {
    await navigator.clipboard.writeText(text);
    shellPrint(copied, "sys");
  } catch {
    shellPrint(`Copy failed — here is the ${what}: ${text}`, "sys");
  }
}

/** Apply what the contact secret field holds: 64 hex characters, or nothing for none. */
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

/** "Add peer", under the peer list: a contact link, or a key with its contact secret beside
 *  it if it has one. */
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

// Default relay URL: same host the page is loaded from (so phones loading
// the shell off a desktop's LAN IP get the right pre-fill out of the box).
// An HTTPS page may open only wss://, so it names its own origin: the proxy that serves
// it over TLS fronts the relay too (seedrelay's droplet script sets both up under one
// name). Otherwise ws:// on the relay's own port; user can override to wss://.
// Falls back to "localhost" on file:// where location.hostname is empty.
function defaultRelayUrl() {
  if (location.protocol === "https:") return `wss://${location.host}`;
  const host = location.hostname || "localhost";
  return `ws://${host}:8080`;
}

// Authenticated peer truth stays in the transport guest, which tells the page who is linked
// each time that changes (`onStatus`): the page draws and passes on what it was told, and
// peers.js dials whoever it wants linked that is not. What it hears is also what the apps
// are told is linked (`postContext`), with the rooms and the contacts: each app's guest is
// told when any of them changes.
//
// Run when the links or the relay's state change, and when who this page wants linked does
// (peers.js `follow`). Nothing here runs by the clock.
function followPeers() {
  tellPeers();
  updatePeerPill();
  renderPeerList();
  postContext();
  media.sync(linkedKeys());
  updateCallStatus();
}

// Auto-reconnect to the last relay that successfully accepted us, in the rooms we were
// in. This is the other half of the reload story: rejoining a room announces our key to
// its members, and the transport links each of them with our new tab.
const savedRelayUrl = sessionStorage.getItem("shell.relayUrl");
const savedRelaySecret = sessionStorage.getItem("shell.relaySecret");
relayUrlInput.value = savedRelayUrl || defaultRelayUrl();
if (savedRelaySecret) relaySecretInput.value = savedRelaySecret;
if (myContactSecret) contactInput.value = toHex(myContactSecret);
let savedRooms = [];
try { savedRooms = JSON.parse(sessionStorage.getItem("shell.rooms") ?? "[]"); } catch {}

// A link that was followed: its room is joined beside the saved ones, and its contact
// added. Nothing of it stays in the address bar, a contact secret least of all.
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
