// Jam's UI. Loaded into a sandboxed iframe by the shell.
//
// What a room holds, how two nodes' copies of it are brought to agree, and how its audio is
// cut and served are room.js, which the page names ahead of this file: a member of a room
// with nothing to show for it. This file is what a person sees and hears of one, and what
// only a listener does: fetching the audio the room is playing, and sounding it.
//
// With the shell (browser/app-api.js) and with this app's guest, through view-lib/app.js,
// which the page names first. Beside what room.js asks of the guest:
//   app.ready()                    this view is listening
//   app.conv({ room })             the room open, which a call is then with
//   app.onContext                  the node's context
//   app.onFrame                    a peer's frame, from someone in its room
//   app.onRender                   [2][from 32][room 32][id 32][bytes]: a peer's block,
//                                  under the id our guest gave it
//
// PLAYING is the room's, and listening is each node's own. `play` says which track, from
// where, and whether it is running. A node that has tuned in asks for the piece the room
// has reached and the ones after it, and holds its own sound to where the room is. It does
// not wait for the whole track, only for enough of it ahead of the room that it will not
// run dry: the room's clock does not stop for a node whose blocks are slow, so a node
// starts once what it holds, and what is still arriving, will carry it through.
//
// A LIBRARY is a member's, and this view is how a person looks through one: it asks for the
// titles that match what was typed (FIND), shows the ones it is told of (FOUND), and asks
// for one to be put in the room's list (PICK), to be played like any other track.
const RENDER_BLOCK = 2;

/** How far ahead of where it is sounding a node keeps its track decoded, in seconds. */
const AHEAD_S = 8;
/** The least of its track a node holds ahead of the room before it starts sounding, in
 *  seconds: what carries it over a link that stutters. */
const CUSHION_S = 4;
/** How much of the speed blocks have been arriving at is counted on to last. */
const COUNT_ON = 0.8;
/** How long the room waits before a track someone starts begins, when not everyone holds
 *  it yet, in seconds: time for the others to fetch its opening. */
const LEAD_IN_S = 1.5;
/** Blocks asked for and not yet here, across every peer: fewer until one has come and said
 *  how fast they do, since what is asked for cannot be called back, and a slow link has to
 *  deliver all of it before anything asked for after. And how long one is waited for. */
const WINDOW = 4;
const WINDOW_BLIND = 2;
const WANT_TIMEOUT_MS = 15000;
/** A block smaller than this says nothing of how fast blocks arrive: its wait is the trip,
 *  not the bytes. */
const FLOW_MIN_BYTES = 16 * 1024;
/** A peer that let a block time out is not asked again for this long. */
const STRIKE_MS = 8000;
/** A library is asked this long after the last key typed, and for no more titles than this. */
const FIND_PAUSE_MS = 250;
const MAX_FOUND = 2000;

const EMOJI = ["👍", "❤️", "😂", "🎉", "🔥", "👀", "😍", "🤩", "😎", "🥳", "😭", "😮", "🙏", "👏", "💯", "✨",
  "🎵", "🎶", "🎸", "🥁", "🎹", "🎷", "🎺", "🎤", "🎧", "💃", "🕺", "🤘", "🙌", "😴", "🤔", "😅",
  "🙃", "😇", "🥲", "😡", "💔", "💜", "🧡", "💚", "⭐", "🌈", "☕", "🍕", "🍻", "🚀", "👎", "🤝"];

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5l9 7-9 7zM16 5h2v14h-2z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 5l-9 7 9 7zM6 5h2v14H6z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 7l-7 9h14z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 17l7-9H5z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3zM5 18h14v2H5z"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg>',
  add: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  react: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 2a7 7 0 110 14 7 7 0 010-14zM9 9.2a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6zm6 0a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6zm-6.6 4.6c.7 1.6 2 2.5 3.6 2.5s2.9-.9 3.6-2.5l-1.4-.6c-.5 1-1.2 1.6-2.2 1.6s-1.7-.6-2.2-1.6z"/></svg>',
};

const $ = (id) => document.getElementById(id);
const main = $("main"), tabs = $("tabs"), logs = $("logs"), emptyNote = $("empty");
const roomSelect = $("room"), hereLabel = $("here"), meLabel = $("me");
const form = $("form"), msgInput = $("msg"), emojiBtn = $("emoji");
const side = $("side"), player = $("player"), npTitle = $("np-title"), npSub = $("np-sub");
const seek = $("seek"), seekFill = $("seek-fill"), npPos = $("np-pos"), npDur = $("np-dur");
const prevBtn = $("prev"), playBtn = $("play"), nextBtn = $("next"), listenBtn = $("listen"), volume = $("volume");
const listEl = $("list"), listCount = $("list-count"), addBtn = $("add"), aloneNote = $("alone"), fileInput = $("file");
const listTitle = $("list-title"), browseBtn = $("browse"), libraryEl = $("library");
const libWho = $("lib-who"), libQuery = $("lib-q"), libList = $("lib-list");
const picker = $("picker"), toasts = $("toasts");

// ── what a listener keeps ───────────────────────────────────────────────
/** The room open, of the ones this node is in (`rooms`, room.js). */
let active = null;

/** The blocks asked of a peer and not yet here: id → { room, t, peer, at }. `asked` is
 *  every id ever asked for, so one that arrives late is still kept. */
const pending = new Map();
const asked = new Set();
/** Peers not to ask for a while, by key: a time on `performance.now()`. */
const strikes = new Map();
/** How fast blocks have been arriving, in this run of asking: the bytes that came and the
 *  seconds they took, each a sum that forgets, so the latest blocks count most; and when
 *  the last one came, or when the asking began. A run that starts after a lull starts from
 *  nothing (`pump`): what came before came from other peers, or over a link that has since
 *  changed. */
const flow = { bytes: 0, seconds: 0, since: 0 };
/** Files being read in, each { room, name, done }. */
const uploads = [];
/** The tracks whose file the user asked for, and that are not all here yet. */
const saving = new Set();
/** Whether this node plays what its room is playing. */
let listening = false;

const short = (id) => id.slice(0, 8);
function nameOf(id) {
  return (id === me ? myNick : nicks.get(id)) || short(id);
}
const hueOf = (id) => parseInt(id.slice(0, 4), 16) % 360;
function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toasts.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ── how much of a track is here ─────────────────────────────────────────
/** Which piece of `t` the place `seconds` into it falls in. */
function pieceAt(t, seconds) {
  const sample = Math.floor(seconds * t.rate);
  let lo = 0, hi = t.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t.starts[mid + 1] > sample) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
/** The linked members that hold `t`. One that just let a block time out is left out while
 *  another can be asked instead. */
function sources(room, t, now) {
  const all = [...holdersOf(room, t.id)].filter((p) => room.peers.has(p));
  const prompt = all.filter((p) => !(strikes.get(p) > now));
  return prompt.length > 0 ? prompt : all;
}
/** How many seconds of `t` this node holds from the place `at` on, with no gap. */
function heldFrom(t, at) {
  if (!store.has(t.head)) return 0;
  if (whole(t)) return t.dur - at;
  let k = pieceAt(t, at);
  while (k < t.blocks.length && store.has(t.blocks[k])) k++;
  return Math.max(0, t.starts[k] / t.rate - at);
}
/** How many seconds of `t` arrive in a second, going by how fast blocks have been coming
 *  and counting on a part of that. Before any has come there is nothing to go by, and it is
 *  taken to be fast. */
function speedOf(t) {
  if (flow.seconds <= 0) return Infinity;
  return ((flow.bytes / flow.seconds) * COUNT_ON) / (t.size / t.dur);
}
/** How much of `t` a node must hold from `at` on before it starts sounding there. Where
 *  blocks come faster than the track plays, a few seconds, against a link that stutters.
 *  Where they come slower, sound once started would run dry and the room would not wait:
 *  so enough that the rest arrives before it is needed, all the way to the track's end. */
function cushion(t, at) {
  const left = t.dur - at, speed = speedOf(t);
  return Math.min(left, speed >= 1 ? CUSHION_S : Math.max(CUSHION_S, (1 - speed) * left));
}
/** Where in its track this node asks for pieces from: where the room is, as a rule. But a
 *  node that is silent, holds nothing where the room is, and has a link too slow to start
 *  at once, would be asking for pieces the room has passed by the time they came. So it
 *  aims ahead, at the place the room will have reached when enough is here to start, asks
 *  from there, and lets the room come to it. */
function aimOf(room, t) {
  const at = Math.max(0, playPos(room));
  if (!room.play.on || soundingAt() >= 0) {
    room.aim = null;
    return at;
  }
  const aim = room.aim && room.aim.v === room.play.v ? room.aim : null;
  if (aim && aim.at >= at) return aim.at;            // the room has yet to come to it
  // The room is where this node aimed, or past it, or it has not aimed yet. What it holds
  // from here is worth adding to if it is gaining on the room, or if it planned for here
  // knowing its speed and is only a little short.
  const speed = speedOf(t), held = heldFrom(t, at);
  if (held > 0 && (speed >= 1 || (aim && aim.known))) return at;
  const lead = speed >= 1 ? CUSHION_S / speed : (1 - speed) * (t.dur - at) + CUSHION_S;
  room.aim = { v: room.play.v, at: Math.min(at + lead, t.dur), known: speed !== Infinity };
  return room.aim.at;
}

// ── this node's own changes ─────────────────────────────────────────────
function post(room, text) {
  apply(room, { msgs: [{ by: me, id: randomHex(8), n: ++room.clock, at: Date.now(), text }] });
}

/** Put this node's `emoji` on `target`, or take it off. */
function react(room, target, emoji) {
  const on = room.reacts.get(target)?.get(emoji)?.get(me)?.on !== true;
  apply(room, { reacts: [{ t: target, e: emoji, by: me, on, n: ++room.clock }] });
}

/** Start a track for the room. Whoever starts one is listening. Unless everyone jamming
 *  holds the track already, it begins a moment from now rather than now, so that the others
 *  have its opening by the time it sounds. */
function start(room, id) {
  tuneIn();
  const t = room.tracks.get(id);
  const held = t && whole(t) && jamming(room).every((peer) => holdersOf(room, id).has(peer));
  setPlay(room, id, held ? 0 : -LEAD_IN_S, true);
}

function togglePlay() {
  const room = active;
  if (!room) return;
  const t = currentTrack(room);
  if (!t) {
    const first = liveTracks(room).find((o) => available(room, o));
    if (first) start(room, first.id);
    return;
  }
  const pos = playPos(room);
  if (room.play.on) { setPlay(room, t.id, Math.max(0, Math.min(pos, t.dur)), false); return; }
  tuneIn();
  setPlay(room, t.id, pos >= t.dur - 0.5 ? 0 : pos, true);
}

/** The next track someone here has, or the one before. Back from well into a track is back
 *  to its start. */
function step(dir) {
  const room = active;
  if (!room) return;
  const order = liveTracks(room);
  const i = order.findIndex((t) => t.id === room.play.id);
  if (dir < 0 && i >= 0 && playPos(room) > 3 && available(room, order[i])) { start(room, order[i].id); return; }
  const ahead = dir > 0 ? order.slice(i + 1) : order.slice(0, i < 0 ? order.length : i).reverse();
  const to = ahead.find((t) => available(room, t));
  if (to) start(room, to.id);
}

/** Move a track one place up or down: to between the two it lands between. */
function move(room, t, dir) {
  const order = liveTracks(room);
  const i = order.indexOf(t);
  const a = order[dir < 0 ? i - 2 : i + 1], b = order[dir < 0 ? i - 1 : i + 2];
  if (i < 0 || (dir < 0 ? !b : !a)) return;
  const pos = a && b ? (a.pos + b.pos) / 2 : a ? a.pos + 1 : b.pos - 1;
  apply(room, { tracks: [{ id: t.id, pos, gone: false, v: ++room.clock, vBy: me }] });
}

function removeTrack(room, t) {
  apply(room, { tracks: [{ id: t.id, pos: t.pos, gone: true, v: ++room.clock, vBy: me }] });
}

// ── audio in: files ─────────────────────────────────────────────────────
/** Check that this browser plays a file the way it was cut: its first piece, decoded on its
 *  own behind the head, as every piece will be. A FLAC piece holds exactly the samples its
 *  frames say, so anything else means the cut is wrong. */
async function proves(ix, file) {
  const first = ix.cuts[0];
  let buf;
  try {
    const bytes = await new Blob([ix.head, file.slice(first.start, first.end)]).arrayBuffer();
    buf = await new OfflineAudioContext(ix.channels, 1, ix.rate).decodeAudioData(bytes);
  } catch { throw new Error("this browser cannot play it"); }
  if (ix.codec === "flac" && buf.length !== first.samples) throw new Error("it does not decode the way it was cut");
}

/** Add files to the room's list, one at a time and in the order they were given, however
 *  many are given at once or while others are still being read. */
let adding = Promise.resolve();
function addFiles(room, files) {
  for (const file of files) {
    const up = { room, name: file.name, done: 0 };
    uploads.push(up);
    adding = adding.then(() => addFile(room, file, up));
  }
  drawSoon();
}

/** Add one file, as a track of this node's (`addTrack`, room.js): cut where its format
 *  allows, once this browser has shown it plays a piece cut that way, and left on disk. */
async function addFile(room, file, up) {
  try {
    await addTrack(room, randomHex(8), file, file.name.replace(/\.[^.]+$/, "") || file.name, {
      progress: (done) => { up.done = done; drawStates(); },
      proves: (ix) => proves(ix, file),
    });
  } catch (err) {
    toast(`${file.name} was not added: ${err.message}.`);
  } finally {
    uploads.splice(uploads.indexOf(up), 1);
    drawSoon();
  }
}

// ── audio across: blocks ────────────────────────────────────────────────
/** A track's head and its pieces from `k` on, each as `[track, block id]`. */
function* piecesFrom(t, k) {
  yield [t, t.head];
  for (let i = k; i < t.blocks.length; i++) yield [t, t.blocks[i]];
}

/** The blocks this node wants, soonest needed first. For a node that listens: the piece it
 *  aims at, which is the one the room has reached unless its link is slow (`aimOf`), and
 *  the rest of that track; then the track after it. While nothing is on, the first track in
 *  the list. Then, listening or not, the tracks being downloaded (`saving`), which nothing
 *  is waiting to sound. And last what came before in the track that is on, so that the node
 *  ends up holding all of it and can serve it. */
function* wants() {
  const room = active;
  if (!room) return;
  const order = liveTracks(room);
  const cur = listening ? currentTrack(room) : null;
  const k = cur ? pieceAt(cur, aimOf(room, cur)) : 0;
  if (cur) {
    yield* piecesFrom(cur, k);
    const next = order[order.indexOf(cur) + 1];
    if (next) yield* piecesFrom(next, 0);
  } else if (listening && order[0]) yield* piecesFrom(order[0], 0);
  for (const t of saving) if (room.tracks.get(t.id) === t) yield* piecesFrom(t, 0);
  if (cur) for (let i = 0; i < k; i++) yield [cur, cur.blocks[i]];
}

/** Ask for blocks until a window of them is on its way, spread over the peers that hold
 *  each one's track. Called whenever there may be room: a block arrived, a peer appeared,
 *  a wait ran out, the room moved. */
let turn = 0;
function pump() {
  const room = active;
  if (!room) return;
  const now = performance.now();
  // With nothing on its way a run of asking is over, and the next is measured by itself:
  // forgotten here, ahead of anything that goes by how fast blocks come.
  if (pending.size === 0) {
    flow.bytes = flow.seconds = 0;
    flow.since = now;
  }
  // Where to ask from is settled every time, room to ask or not: on a slow link there
  // seldom is room, and that is when it matters.
  const cur = listening ? currentTrack(room) : null;
  if (cur) aimOf(room, cur);
  let free = (flow.seconds > 0 ? WINDOW : WINDOW_BLIND) - pending.size;
  if (free <= 0) return;
  const from = new Map(), asks = new Map();
  for (const [t, id] of wants()) {
    if (free <= 0) break;
    if (store.has(id) || pending.has(id)) continue;
    if (!from.has(t)) from.set(t, sources(room, t, now));
    const peers = from.get(t);
    if (peers.length === 0) continue;
    const peer = peers[turn++ % peers.length];
    pending.set(id, { room, t, peer, at: now });
    asked.add(id);
    asks.set(peer, [...(asks.get(peer) ?? []), id]);
    free--;
  }
  for (const [peer, ids] of asks) app.tell(room.id, peer, [WANT], fromHex(ids.join("")));
}

/** A block a peer sent, named by our own guest. Kept if it is one this node asked for. */
function onBlock(from, id, bytes) {
  if (!asked.has(id) || store.has(id)) return;
  const w = pending.get(id);
  pending.delete(id);
  store.set(id, new Blob([bytes]));
  if (w) {
    const now = performance.now();
    if (bytes.length >= FLOW_MIN_BYTES) {
      flow.bytes = flow.bytes * 0.8 + bytes.length;
      flow.seconds = flow.seconds * 0.8 + (now - flow.since) / 1000;
      flow.since = now;
    }
    // A peer that is delivering is not one to give up on, however slowly: what else was
    // asked of it is waited for from now.
    for (const other of pending.values()) if (other.peer === from) other.at = now;
  }
  // Holding all of a track is news for the room: this node can now serve it.
  for (const room of rooms.values()) {
    for (const t of room.tracks.values()) {
      if (t.blocks && !t.gone && !t.told && (w ? t === w.t : t.head === id || t.blocks.includes(id)) && whole(t)) {
        t.told = true;
        castDoc(room, { have: [t.id] });
      }
    }
  }
  for (const t of saving) if (whole(t)) void save(t);
  syncAudio();
  drawStates();
  drawPlayer();
  pump();
}

/** A peer does not have blocks it was asked for: it is not a holder of those tracks. */
function onNack(room, from, ids) {
  for (const id of ids) {
    const w = pending.get(id);
    if (!w || w.peer !== from) continue;
    pending.delete(id);
    holdersOf(w.room, w.t.id).delete(from);
  }
  drawStates();
  pump();
}

// ── audio back out: a file ──────────────────────────────────────────────
/** Hand the user a track as a file. One this node does not hold all of is fetched first,
 *  whether or not the node listens (`wants`), and saved when its last block is here. */
function download(room, t) {
  if (whole(t)) { void save(t); return; }
  if (sources(room, t, performance.now()).length === 0) {
    toast(`${t.title} cannot be downloaded: nobody here has it.`);
    return;
  }
  saving.add(t);
  drawStates();
  pump();
}

/** Save a track this node holds all of: its head and then its pieces, end to end. The
 *  pieces are the bytes of the file that was added, so the audio is that file's, untouched.
 *  An Ogg Vorbis track comes out as the file itself. A FLAC track comes out as the file's
 *  frames behind the head its pieces are decoded behind, now saying how long the stream is
 *  (formats.js): what the file held besides audio, its tags and pictures, no peer was sent.
 *
 *  The view saves it itself, as a link to a blob, which is the one thing its sandbox lets
 *  it hand the user (`allow-downloads`, shell.js). */
async function save(t) {
  saving.delete(t);
  const flac = t.codec === "flac";
  // Taken now: a track removed while the head is read lets go of its blocks.
  const parts = [t.head, ...t.blocks].map((b) => store.get(b));
  if (flac) parts[0] = flacFileHead(new Uint8Array(await parts[0].arrayBuffer()), t.starts[t.blocks.length]);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(parts, { type: flac ? "audio/flac" : "audio/ogg" }));
  link.download = `${t.title}.${flac ? "flac" : "ogg"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

// ── audio out ───────────────────────────────────────────────────────────
// A track sounds a piece at a time. Each piece is decoded on its own, behind the track's
// head, into the samples it holds, and the pieces are set down end to end on the audio
// clock, each starting on the sample the one before it stopped at. So a node needs only the
// piece the room has reached to start sounding, holds a few seconds decoded however long
// the track is, and what it sounds is the file's own samples.
//
// Web Audio does the decoding, not an <audio> element, which cannot be given the bytes:
// this page is sandboxed into an origin of its own, and a media element there never loads a
// blob: URL. It is the same wall that keeps a view from the microphone. The context runs at
// the track's own sample rate, so nothing here resamples.
let audioCtx = null;
let gain = null;
/** The sample rate `audioCtx` was made for. */
let ctxRate = 0;
/** What this node is sounding, or null while it is silent:
 *
 *    t       the track
 *    zero    when sample 0 of the track falls on the context's clock, in samples
 *    k       the next piece to decode
 *    until   the sample the pieces set down so far run to
 *    busy    whether a piece is being decoded
 *    from    when the first piece set down starts, on the context's clock; null before one is
 *    nodes   the source nodes set down and not yet over
 *    out     what they play into, which fades the whole of it in and out */
let session = null;

/** Have the audio context run at `rate`, in place of one that runs at another. */
function tune(rate) {
  if (audioCtx && ctxRate === rate) return;
  hush();
  if (audioCtx) void audioCtx.close();
  // A rate the browser will not run a context at is left to it to convert.
  try { audioCtx = new AudioContext({ sampleRate: rate }); } catch { audioCtx = new AudioContext(); }
  ctxRate = rate;
  gain = audioCtx.createGain();
  gain.gain.value = Number(volume.value);
  gain.connect(audioCtx.destination);
}

/** Start listening. Always behind a click, which is when a browser lets a page that has
 *  made no sound yet make some. */
function tuneIn() {
  listening = true;
  const t = active ? currentTrack(active) : null;
  tune(t ? t.rate : ctxRate || 44100);
  if (audioCtx.state !== "running") void audioCtx.resume();
}

/** Stop sounding: fade out over a moment rather than cut a wave off mid-swing. */
function hush() {
  const s = session;
  if (!s) return;
  session = null;
  const now = audioCtx.currentTime;
  s.out.gain.cancelScheduledValues(now);
  s.out.gain.setValueAtTime(s.out.gain.value, now);
  s.out.gain.linearRampToValueAtTime(0, now + 0.015);
  for (const node of s.nodes) {
    node.onended = null;
    try { node.stop(now + 0.02); } catch {}
  }
  setTimeout(() => s.out.disconnect(), 200);
}

/** Where this node's own audio is in its track, in seconds, or -1 while it is silent. */
function soundingAt() {
  const s = session;
  if (!s || s.from === null || s.nodes.size === 0 || audioCtx.currentTime < s.from) return -1;
  return audioCtx.currentTime - s.zero / s.t.rate;
}

/** Set a decoded piece down on the clock. `buf` is piece `k` as it decoded: its own samples
 *  are the last `lens[k]` of it, since a lead-in decodes in front of them, and a piece that
 *  came out short is short at its start. What of it is already in the past is left off, so
 *  the rest falls where it belongs. Every start is a whole number of samples from the
 *  session's zero, which is what joins one piece to the next without a seam. */
function setDown(s, k, buf) {
  const t = s.t;
  const scale = buf.sampleRate / t.rate;                       // 1, unless the context could not run at the track's rate
  const own = Math.min(buf.length, Math.round(t.lens[k] * scale));
  const starts = (s.zero + t.starts[k + 1]) / t.rate - own / buf.sampleRate;
  const late = Math.max(0, Math.ceil((audioCtx.currentTime + 0.03 - starts) * buf.sampleRate));
  s.until = t.starts[k + 1];
  if (late >= own) return;
  let piece = buf;
  if (own - late !== buf.length) {
    piece = audioCtx.createBuffer(buf.numberOfChannels, own - late, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) piece.copyToChannel(buf.getChannelData(ch).subarray(buf.length - own + late), ch);
  }
  const when = starts + late / buf.sampleRate;
  const node = audioCtx.createBufferSource();
  node.buffer = piece;
  node.connect(s.out);
  node.onended = () => s.nodes.delete(node);
  node.start(when);
  s.nodes.add(node);
  if (s.from !== null) return;
  s.from = when;
  // Coming in partway through a track, fade in: a wave joined mid-swing clicks.
  if (when - s.zero / t.rate > 0.05) {
    s.out.gain.setValueAtTime(0, when);
    s.out.gain.linearRampToValueAtTime(1, when + 0.015);
  }
}

/** Decode the session's next piece once it is near enough to be needed, and set it down.
 *  One at a time and in order. A Vorbis piece is decoded with the end of the piece before
 *  it in front, if this node holds that one (formats.js). */
function feed() {
  const s = session, t = s.t, k = s.k;
  if (s.busy || k >= t.blocks.length || !store.has(t.blocks[k])) return;
  if (t.starts[k] / t.rate > audioCtx.currentTime - s.zero / t.rate + AHEAD_S) return;
  s.busy = true;
  const parts = [store.get(t.head)];
  const before = k > 0 && t.pre && t.pre[k] > 0 ? store.get(t.blocks[k - 1]) : undefined;
  if (before && before.size >= t.pre[k]) parts.push(before.slice(before.size - t.pre[k]));
  parts.push(store.get(t.blocks[k]));
  const ctx = audioCtx;
  new Blob(parts).arrayBuffer().then((bytes) => ctx.decodeAudioData(bytes)).then((buf) => {
    if (session !== s) return;
    s.busy = false;
    s.k = k + 1;
    setDown(s, k, buf);
    feed();
  }, () => {
    if (session !== s) return;
    // A piece that will not decode is a silence its own length, and the track goes on.
    s.busy = false;
    s.k = k + 1;
    s.until = t.starts[k + 1];
    if (!t.bad) toast(`This browser cannot play part of ${t.title}.`);
    t.bad = true;
    feed();
  });
}

/** Hold this node's audio to where its room is: the room's track, from the room's place in
 *  it, sounding if the room is running and this node listens. Called on every change and on
 *  a tick, which is what decodes the next piece in time and corrects any drift.
 *
 *  It does not start until this node holds enough ahead of the room (`cushion`), which is
 *  what keeps slow blocks from stalling it. Sound that runs dry all the same stops rather
 *  than waits, since the room does not wait, and starts again where the room then is, once
 *  enough is here again. */
function syncAudio() {
  const room = active;
  const t = room && listening && room.play.on ? currentTrack(room) : null;
  const at = t ? playPos(room) : 0;
  if (!t || at >= t.dur) {
    hush();
    return;
  }
  if (session && session.t === t) {
    const here = audioCtx.currentTime - session.zero / t.rate;
    const dry = !session.busy && session.k < t.blocks.length && here * t.rate >= session.until;
    if (Math.abs(here - at) < 0.3 && !dry) {
      feed();
      return;
    }
  }
  hush();
  // The room may be a moment before the track's start: then this is set down ahead of time.
  const from = Math.max(0, at);
  if (heldFrom(t, from) < cushion(t, from) - 0.001) return;   // on its way: `pump` has asked
  const k = pieceAt(t, from);
  tune(t.rate);
  if (audioCtx.state !== "running") {
    void audioCtx.resume();   // sounding starts on the tick after it has
    return;
  }
  const out = audioCtx.createGain();
  out.connect(gain);
  session = { t, zero: Math.round((audioCtx.currentTime - at) * t.rate), k, until: t.starts[k], busy: false, from: null, nodes: new Set(), out };
  feed();
}

// ── drawing ─────────────────────────────────────────────────────────────
function button(cls, label, html, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = label;
  b.setAttribute("aria-label", label);
  if (html) b.innerHTML = html;
  b.addEventListener("click", onClick);
  return b;
}

/** The reactions on `target`: one chip an emoji, with how many, lit if one is ours. */
function chips(room, target) {
  const row = document.createElement("div");
  row.className = "chips";
  for (const [emoji, byPeer] of room.reacts.get(target) ?? []) {
    const who = [...byPeer].filter(([, r]) => r.on).map(([id]) => id);
    if (who.length === 0) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip${who.includes(me) ? " mine" : ""}`;
    chip.title = who.map(nameOf).join(", ");
    chip.addEventListener("click", () => react(room, target, emoji));
    const count = document.createElement("b");
    count.textContent = who.length;
    chip.append(emoji, count);
    row.appendChild(chip);
  }
  return row;
}

const atBottom = () => logs.scrollHeight - logs.scrollTop - logs.clientHeight < 40;

/** Put a line in a room's log where its clock says it goes. Nearly always the end. */
function place(room, el, n, key) {
  el.dataset.n = n;
  el.dataset.key = key;
  let before = null;
  for (let c = room.log.lastElementChild; c; c = c.previousElementSibling) {
    const cn = Number(c.dataset.n);
    if (cn < n || (cn === n && c.dataset.key < key)) break;
    before = c;
  }
  const stick = room === active && atBottom();
  room.log.insertBefore(el, before);
  room.els.set(key, el);
  if (stick) logs.scrollTop = logs.scrollHeight;
}

function whoSpan(id) {
  const who = document.createElement("span");
  who.className = "who";
  who.dataset.who = id;
  who.style.color = `hsl(${hueOf(id)} 70% 72%)`;
  who.textContent = nameOf(id);
  return who;
}

function drawMessage(room, m) {
  const el = document.createElement("div");
  el.className = "msg";
  // A message of nothing but a few emoji is drawn large.
  if (m.text.length <= 12 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u.test(m.text) && /\p{Extended_Pictographic}/u.test(m.text)) el.classList.add("big");
  const head = document.createElement("div");
  head.className = "msg-head";
  head.appendChild(whoSpan(m.by));
  if (m.at > 0) {
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    head.appendChild(when);
  }
  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = m.text;
  const reactBtn = button("react icon ghost", "React", ICON.react, () => openPicker(reactBtn, (emoji) => react(room, m.key, emoji)));
  el.append(head, text, chips(room, m.key), reactBtn);
  place(room, el, m.n, m.key);
}

function drawAdded(room, t) {
  const el = document.createElement("div");
  el.className = "event";
  const title = document.createElement("b");
  title.textContent = t.title;
  el.append("♪ ", whoSpan(t.by), " added ", title);
  place(room, el, t.n, `t:${t.id}`);
}

/** Draw what a merge changed. `from` is the peer whose document it was, for the chat tab's
 *  dot. */
function refresh(room, changed, from) {
  for (const key of changed.msgs) drawMessage(room, room.msgs.get(key));
  for (const id of changed.added) drawAdded(room, room.tracks.get(id));
  for (const target of changed.reacts) {
    if (target.startsWith("t:")) { changed.list = true; continue; }
    room.els.get(target)?.querySelector(".chips")?.replaceWith(chips(room, target));
  }
  if (from && changed.msgs.length > 0 && room === active && main.dataset.tab !== "chat") {
    tabs.querySelector('[data-tab="chat"]').classList.add("dot");
  }
  if (room !== active) return;
  emptyNote.hidden = room.log.childElementCount > 0;
  if (changed.list || changed.play) {
    drawSoon();
    syncAudio();
    pump();
  }
}

/** The list's rows as drawn, each { t, li, play, sub, fill }, and each file being read in with
 *  its row's line of text. Kept so that what only moves, how much of a track is here, is
 *  written into the rows that are there: a list rebuilt under a click loses the click. */
let rows = [];

/** Why a track is not ready to play here, or nothing if it is. */
function trackState(room, t) {
  if (whole(t)) return "";
  if (!available(room, t)) return "nobody here has it";
  const held = t.blocks.filter((b) => store.has(b)).length;
  const part = `${Math.floor((100 * held) / t.blocks.length)}%`;
  if (!saving.has(t) && (held > 0 || t.blocks.some((b) => pending.has(b)))) return part;
  return saving.has(t) ? `downloading… ${part}` : "";
}

function drawList() {
  const room = active;
  listEl.replaceChildren();
  listCount.textContent = "";
  rows = [];
  if (!room) return;
  const order = liveTracks(room);
  if (order.length > 0 && !shelf) {
    listCount.textContent = `${order.length} track${order.length === 1 ? "" : "s"} · ${fmtTime(order.reduce((s, t) => s + t.dur, 0))}`;
  }
  order.forEach((t, i) => {
    const li = document.createElement("li");
    const current = room.play.id === t.id;
    li.className = `track${current ? " current" : ""}${current && room.play.on ? " playing" : ""}`;
    li.dataset.id = t.id;
    const startBtn = button("start icon ghost", `Play ${t.title}`, current && room.play.on ? '<span class="eq"><i></i><i></i><i></i><i></i></span>' : ICON.play,
      () => start(room, t.id));
    const mainEl = document.createElement("div");
    mainEl.className = "t-main";
    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = t.title;
    const sub = document.createElement("div");
    sub.className = "t-sub";
    mainEl.append(title, sub, chips(room, `t:${t.id}`));
    const acts = document.createElement("div");
    acts.className = "t-acts";
    const reactBtn = button("icon ghost", "React", ICON.react, () => openPicker(reactBtn, (emoji) => react(room, `t:${t.id}`, emoji)));
    const up = button("icon ghost", "Move up", ICON.up, () => move(room, t, -1));
    const down = button("icon ghost", "Move down", ICON.down, () => move(room, t, 1));
    up.disabled = i === 0;
    down.disabled = i === order.length - 1;
    acts.append(reactBtn, up, down, button("icon ghost", "Download", ICON.save, () => download(room, t)),
      button("icon ghost", "Remove", ICON.remove, () => removeTrack(room, t)));
    const fill = document.createElement("div");
    fill.className = "t-fill";
    li.append(startBtn, mainEl, acts, fill);
    listEl.appendChild(li);
    rows.push({ t, li, play: startBtn, sub, fill });
  });
  // What is on its way into the list: a file being read in, and a title a library was
  // asked for.
  const coming = (name, says) => {
    const li = document.createElement("li");
    li.className = "track away";
    const mainEl = document.createElement("div");
    mainEl.className = "t-main";
    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = name;
    const sub = document.createElement("div");
    sub.className = "t-sub";
    sub.textContent = says;
    mainEl.append(title, sub);
    li.appendChild(mainEl);
    listEl.appendChild(li);
    return sub;
  };
  for (const up of uploads) if (up.room === room) up.sub = coming(up.name, "");
  for (const p of picks.values()) if (p.room === room) coming(leafOf(p.path), `${nameOf(p.peer)} is adding it…`);
  if (listEl.childElementCount === 0) {
    const li = document.createElement("li");
    li.className = "none note";
    li.textContent = "No music yet. Add some, or drop audio files here: everyone in the room gets the list, and can play it.";
    listEl.appendChild(li);
  }
  drawStates();
}

/** Write into the rows what moves while audio does: how much of each track is here, and how
 *  far each file has been read. */
function drawStates() {
  const room = active;
  if (!room) return;
  for (const { t, li, play, sub, fill } of rows) {
    const state = trackState(room, t);
    // A track nobody here has is not started, and the room passes over it (`moveOn`).
    play.disabled = state === "nobody here has it";
    li.classList.toggle("away", play.disabled);
    sub.textContent = [fmtTime(t.dur), nameOf(t.by), fmtSize(t.size), state].filter(Boolean).join(" · ");
    fill.hidden = whole(t);
    fill.style.width = `${(100 * t.blocks.filter((b) => store.has(b)).length) / t.blocks.length}%`;
  }
  for (const up of uploads) if (up.sub) up.sub.textContent = `reading… ${Math.floor(up.done * 100)}%`;
}

function drawPlayer() {
  const room = active;
  const t = room ? currentTrack(room) : null;
  const on = !!t && room.play.on;
  player.classList.toggle("playing", on);
  // On a narrow page the player is behind a tab, which then says the room is playing.
  tabs.querySelector('[data-tab="side"]').classList.toggle("on", on);
  npTitle.textContent = t ? t.title : "Nothing playing";
  let sub = "";
  if (t) {
    const at = playPos(room);
    if (on && at < 0) sub = "starting…";
    else if (listening && on && at < t.dur && soundingAt() < 0) {
      // A node that listens and hears nothing is waiting to hold enough, and on a slow link
      // knows about when that will be.
      const wait = (room.aim ? room.aim.at : at) - at;
      sub = !available(room, t) ? "nobody here has it"
        : wait > 3 ? `buffering… joins in ${fmtTime(wait)}` : "buffering…";
    } else sub = `${on ? "started" : "paused"} by ${room.play.by === me ? "you" : nameOf(room.play.by)}`;
  } else if (room && liveTracks(room).length > 0) sub = "press play to start the room";
  npSub.textContent = sub;
  const label = on ? "Pause for everyone" : "Play for everyone";
  if (playBtn.title !== label) {
    playBtn.innerHTML = on ? ICON.pause : ICON.play;
    playBtn.title = label;
    playBtn.setAttribute("aria-label", label);
  }
  const any = !!room && liveTracks(room).length > 0;
  playBtn.disabled = prevBtn.disabled = nextBtn.disabled = !any;
  listenBtn.textContent = listening ? "🔊 Listening" : "🔇 Tune in";
  listenBtn.classList.toggle("on", listening);
  // Something is on and this node is not hearing it.
  listenBtn.classList.toggle("nudge", on && !listening);
  listenBtn.setAttribute("aria-pressed", String(listening));
  volume.hidden = !listening;
  // Music is added to a room, and is for whoever else is in it. Where there is no room, or
  // nobody else in it is linked, the list says so: a button that only greys out does not
  // say why. Linked, not jamming: a peer that has yet to answer `hello` is there all the same.
  // While a library is open it has the list's place, and its button leads back.
  addBtn.hidden = !room || !!shelf;
  const alone = !room ? "Not connected to a room. Join one on the Network tab to add music."
    : room.peers.size > 0 ? ""
    : "Nobody else is connected here yet: music you add is shared once someone joins.";
  aloneNote.textContent = alone;
  aloneNote.hidden = alone === "" || !!shelf;
  browseBtn.hidden = !shelf && (!room || librariesOf(room).length === 0);
  browseBtn.textContent = shelf ? "Playlist" : "Library";
  drawProgress();
}

function drawProgress() {
  const room = active;
  const t = room ? currentTrack(room) : null;
  const pos = t ? Math.max(0, Math.min(playPos(room), t.dur)) : 0;
  const part = t ? pos / t.dur : 0;
  seekFill.style.width = `${part * 100}%`;
  seek.setAttribute("aria-valuenow", String(Math.round(part * 100)));
  npPos.textContent = fmtTime(pos);
  npDur.textContent = t ? fmtTime(t.dur) : "";
  // Where this node's own audio is, for whoever looks from outside: only while it sounds.
  const at = soundingAt();
  if (at >= 0) player.dataset.at = at.toFixed(2);
  else delete player.dataset.at;
}

/** Redraw the list and the player once, after whatever is changing them has finished. */
let drawing = false;
function drawSoon() {
  if (drawing) return;
  drawing = true;
  queueMicrotask(() => {
    drawing = false;
    drawList();
    drawLibrary();
    drawPlayer();
  });
}

function drawHeader() {
  roomSelect.replaceChildren();
  const sorted = [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const room of sorted) roomSelect.add(new Option(`# ${room.name}`, room.id, false, room === active));
  if (sorted.length === 0) roomSelect.add(new Option("no room", ""));
  roomSelect.disabled = sorted.length === 0;
  const here = active ? [me, ...jamming(active)] : [];
  hereLabel.textContent = active ? `${here.length} here` : "";
  hereLabel.title = here.map(nameOf).join(", ");
  meLabel.textContent = me ? (myNick ? `${myNick} (${short(me)})` : `${short(me)} — set a nick on the Network tab`) : "";
  msgInput.disabled = !active;
  emptyNote.hidden = !!active && active.log.childElementCount > 0;
  emptyNote.textContent = active ? "Say something, or add some music."
    : "Join a room on the Network tab: a room is who you jam with.";
  for (const el of document.querySelectorAll("[data-who]")) el.textContent = nameOf(el.dataset.who);
}

/** Open one room, and tell the shell which: a call started now is with it. */
function openRoom(room) {
  if (active) active.log.hidden = true;
  active = room;
  shelf = null;   // a library is a member's of the room that was open
  if (room) {
    room.log.hidden = false;
    logs.scrollTop = logs.scrollHeight;
  }
  app.conv(room ? { room: room.id } : undefined);
  drawHeader();
  drawSoon();
  syncAudio();
  pump();
}

// ── a library ───────────────────────────────────────────────────────────
// A member with more music than a list is for says how many titles it has (`library`,
// room.js), and the list's Library button opens it in the list's place: a field to type
// in, and the titles that match what is typed, each to be played now or put at the list's
// end. Either is asked of the member whose library it is (PICK), which adds the track
// itself: this node hears of it as it does of any track, and knows it by the id it chose.

/** The library open, or null: whose it is, what was typed, and the titles heard so far of
 *  the `total` that match, which is null until an answer has come:
 *  { room, peer, q, titles: [{ path, size }], total }. */
let shelf = null;
/** The titles picked and not yet in the list, by the id each is to be a track under:
 *  { room, peer, path, play }, `play` for one to start as soon as it is there. */
const picks = new Map();
/** The wait after a key typed, before the library is asked. */
let typing = null;

/** The linked members of `room` that say they have a library. */
function librariesOf(room) {
  return [...room.libraries.keys()].filter((id) => room.peers.has(id)).sort();
}
/** A title as a list shows it: its file's name without what kind of file it is, and the
 *  folders it is in. */
const leafOf = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") || path;
const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Ask the open library for the titles that match what was typed, from the `from`th on. */
function askLibrary(from) {
  tellJson(shelf.room, shelf.peer, FIND, { q: shelf.q, from });
}

function openLibrary(room, peer) {
  shelf = { room, peer, q: "", titles: [], total: null };
  libQuery.value = "";
  askLibrary(0);
  drawSoon();
}

function closeLibrary() {
  shelf = null;
  drawSoon();
}

/** A library's answer: the next titles of the ones that match. Taken if it is the open
 *  library's, for what is typed now, and goes on from the titles already here. An answer
 *  that adds none is the end of them, whatever it says of how many there are. */
function onFound(room, from, found) {
  if (!shelf || shelf.room !== room || shelf.peer !== from || !found) return;
  if (found.q !== shelf.q || found.from !== shelf.titles.length) return;
  const had = shelf.titles.length;
  for (const t of listOf(found.titles, 200)) {
    if (t && typeof t.path === "string" && t.path !== "" && t.path.length <= MAX.path && isCount(t.size)) shelf.titles.push({ path: t.path, size: t.size });
  }
  shelf.total = Math.max(shelf.titles.length, shelf.titles.length > had && isCount(found.total) ? found.total : 0);
  drawLibrary();
}

/** Ask for a title to be put in the room's list, and with `play` to start it once it is
 *  there. Whoever starts a track is listening, and a browser lets a page make sound only
 *  behind a click, which is now and not when the track comes. */
function pickTitle(title, play) {
  const { room, peer } = shelf;
  if (play) tuneIn();
  const id = randomHex(8);
  picks.set(id, { room, peer, path: title.path, play });
  tellJson(room, peer, PICK, { path: title.path, id });
  drawSoon();
}

/** A track is in the list. One this node picked is no longer waited for, and starts if
 *  that was asked. */
function onPicked(room, id) {
  const p = picks.get(id);
  if (!p || p.room !== room) return;
  picks.delete(id);
  if (p.play) start(room, id);
  drawSoon();
}

/** A library did not add a title it was asked for, and says why. */
function onMiss(room, from, miss) {
  const p = miss ? picks.get(miss.id) : undefined;
  if (!p || p.room !== room || p.peer !== from) return;
  picks.delete(miss.id);
  const why = typeof miss.why === "string" && miss.why !== "" ? miss.why.slice(0, 200) : "its library could not add it";
  toast(`${leafOf(p.path)} was not added: ${why}.`);
  drawSoon();
}

/** The context changed. A library whose member is gone is closed, and what was picked from
 *  it is not coming. */
function libraryLeft() {
  const there = (room, peer) => rooms.get(room.id) === room && room.peers.has(peer);
  for (const [id, p] of picks) {
    if (there(p.room, p.peer)) continue;
    picks.delete(id);
    toast(`${leafOf(p.path)} was not added: its library has left.`);
  }
  if (shelf && !(there(shelf.room, shelf.peer) && shelf.room.libraries.has(shelf.peer))) shelf = null;
}

/** A line of a library's list that is not a title: what it says, or a button. */
function libraryLine(cls, ...what) {
  const li = document.createElement("li");
  li.className = cls;
  li.append(...what);
  libList.appendChild(li);
}

function drawLibrary() {
  libraryEl.hidden = !shelf;
  listEl.hidden = !!shelf;
  listTitle.textContent = shelf ? "Library" : "Playlist";
  if (!shelf) return;
  const { room, peer, q, titles, total } = shelf;
  // Whose it is, to choose between where more than one member has a library.
  const whose = librariesOf(room);
  if (document.activeElement !== libWho) {
    libWho.replaceChildren();
    for (const id of whose) libWho.add(new Option(nameOf(id), id, false, id === peer));
  }
  libWho.hidden = whose.length < 2;
  const holds = room.libraries.get(peer);
  libQuery.placeholder = `Search ${nameOf(peer)}'s ${holds} title${holds === 1 ? "" : "s"}`;
  listCount.textContent = total === null ? "" : q === "" ? `${total} title${total === 1 ? "" : "s"}` : `${total} match${total === 1 ? "" : "es"}`;

  libList.replaceChildren();
  const coming = new Set([...picks.values()].filter((p) => p.room === room && p.peer === peer).map((p) => p.path));
  for (const title of titles) {
    const name = leafOf(title.path), waited = coming.has(title.path);
    const li = document.createElement("li");
    li.className = `track${waited ? " away" : ""}`;
    const startBtn = button("start icon ghost", `Play ${name}`, ICON.play, () => pickTitle(title, true));
    const mainEl = document.createElement("div");
    mainEl.className = "t-main";
    const head = document.createElement("div");
    head.className = "t-title";
    head.textContent = name;
    const sub = document.createElement("div");
    sub.className = "t-sub";
    sub.textContent = [folderOf(title.path), fmtSize(title.size), waited ? "adding…" : ""].filter(Boolean).join(" · ");
    mainEl.append(head, sub);
    const acts = document.createElement("div");
    acts.className = "t-acts";
    const addToList = button("icon ghost", `Add ${name} to the list`, ICON.add, () => pickTitle(title, false));
    startBtn.disabled = addToList.disabled = waited;
    acts.appendChild(addToList);
    li.append(startBtn, mainEl, acts);
    libList.appendChild(li);
  }
  if (total === null) libraryLine("none note", "Asking…");
  else if (titles.length === 0) libraryLine("none note", q === "" ? "This library is empty." : "Nothing in this library matches.");
  else if (titles.length < total && titles.length < MAX_FOUND) {
    const more = button("", "More titles", "", () => askLibrary(titles.length));
    more.textContent = "More";
    libraryLine("more", more);
  }
}

// ── the emoji picker ────────────────────────────────────────────────────
let picked = null;
for (const emoji of EMOJI) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = emoji;
  b.addEventListener("click", () => {
    const done = picked;
    closePicker();
    done?.(emoji);
  });
  picker.appendChild(b);
}
function openPicker(anchor, onPick) {
  picked = onPick;
  picker.hidden = false;
  const a = anchor.getBoundingClientRect(), p = picker.getBoundingClientRect();
  const left = Math.max(6, Math.min(a.left, window.innerWidth - p.width - 6));
  const top = a.top - p.height - 6 >= 6 ? a.top - p.height - 6 : Math.min(a.bottom + 6, window.innerHeight - p.height - 6);
  picker.style.left = `${left}px`;
  picker.style.top = `${Math.max(6, top)}px`;
}
function closePicker() {
  picker.hidden = true;
  picked = null;
}
document.addEventListener("pointerdown", (e) => {
  if (!picker.hidden && !picker.contains(e.target)) closePicker();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });

// ── what the shell hands us ─────────────────────────────────────────────
/** Let go of what a listener was doing with a track that is in no list here any more. */
function quiet(t) {
  if (session && session.t === t) hush();
  saving.delete(t);
}

/** A room here changed (`merge`, room.js). What was being fetched, sounded or saved of a
 *  track that is gone stops, a message too old to keep leaves the log, a title that was
 *  picked is a track now, and the rest is drawn. */
jam.changed = (room, changed, from) => {
  for (const t of changed.gone) quiet(t);
  for (const id of changed.freed) pending.delete(id);
  for (const key of changed.trimmed) {
    room.els.get(key)?.remove();
    room.els.delete(key);
  }
  refresh(room, changed, from);
  for (const id of changed.added) onPicked(room, id);
  if (!changed.peers) return;
  drawHeader();
  drawStates();
  drawPlayer();
  pump();
};

/** The node's context, which room.js keeps. What is left to a view is a log for each room
 *  this node is newly in, an end to what it was doing with the ones it has left, and a
 *  room to show. */
function onContext(ctx) {
  const { joined, left } = memberContext(ctx);
  for (const room of joined) {
    room.aim = null;        // where this node asks from while it waits to start: { v, at, known } (`aimOf`)
    room.els = new Map();   // what is drawn in the log, by key
    room.log = document.createElement("div");
    room.log.hidden = true;
    logs.appendChild(room.log);
  }
  for (const room of left) {
    for (const t of room.tracks.values()) quiet(t);
    for (const [id, w] of pending) if (w.room === room) pending.delete(id);
    room.log.remove();
  }
  libraryLeft();
  if (!active || !rooms.has(active.id)) openRoom([...rooms.values()].sort((a, b) => a.name.localeCompare(b.name))[0] ?? null);
  else { drawHeader(); drawSoon(); pump(); }
}

/** A peer's frame, from a member of the room it names: [type u8][body]. What every member
 *  answers is room.js's. A listener is also told that a block is not to be had, and what
 *  a library holds. */
function onFrame(from, id, frame) {
  const room = rooms.get(id);
  if (!room || frame.length < 1) return;
  const body = frame.subarray(1);
  if (frame[0] === NACK) onNack(room, from, idsOf(body));
  else if (frame[0] === FOUND) onFound(room, from, jsonOf(body));
  else if (frame[0] === MISS) onMiss(room, from, jsonOf(body));
  else memberFrame(room, from, frame);
}

app.onContext(onContext);
app.onFrame(onFrame);
app.onRender((p) => {
  if (p[0] === RENDER_BLOCK && p.length >= 97) onBlock(toHex(p.subarray(1, 33)), toHex(p.subarray(65, 97)), p.subarray(97));
});

// ── what the user does ──────────────────────────────────────────────────
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text || !active) return;
  post(active, text);
  msgInput.value = "";
  logs.scrollTop = logs.scrollHeight;
  msgInput.focus();
});
emojiBtn.addEventListener("click", () => openPicker(emojiBtn, (emoji) => {
  const at = msgInput.selectionStart ?? msgInput.value.length;
  msgInput.setRangeText(emoji, at, msgInput.selectionEnd ?? at, "end");
  msgInput.focus();
}));

roomSelect.addEventListener("change", () => openRoom(rooms.get(roomSelect.value) ?? null));
for (const b of tabs.querySelectorAll("button")) {
  b.addEventListener("click", () => {
    main.dataset.tab = b.dataset.tab;
    for (const other of tabs.querySelectorAll("button")) other.classList.toggle("active", other === b);
    b.classList.remove("dot");
  });
}

prevBtn.innerHTML = ICON.prev;
nextBtn.innerHTML = ICON.next;
playBtn.addEventListener("click", togglePlay);
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));
listenBtn.addEventListener("click", () => {
  if (listening) {
    listening = false;
    void audioCtx.suspend();
  } else tuneIn();
  drawSoon();
  syncAudio();
  pump();
});
volume.addEventListener("input", () => { if (gain) gain.gain.value = Number(volume.value); });

/** Move the room to a place in its track. */
function seekTo(part) {
  const room = active;
  const t = room ? currentTrack(room) : null;
  if (t) setPlay(room, t.id, Math.max(0, Math.min(1, part)) * t.dur, room.play.on);
}
seek.addEventListener("click", (e) => {
  const box = seek.getBoundingClientRect();
  seekTo((e.clientX - box.left) / box.width);
});
seek.addEventListener("keydown", (e) => {
  const t = active ? currentTrack(active) : null;
  if (!t || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  e.preventDefault();
  seekTo((playPos(active) + (e.key === "ArrowLeft" ? -5 : 5)) / t.dur);
});

// The list's place goes to a library and back. What is typed is asked for once the typing
// has paused, from the first title again.
browseBtn.addEventListener("click", () => {
  if (shelf) closeLibrary();
  else if (active && librariesOf(active).length > 0) openLibrary(active, librariesOf(active)[0]);
});
libWho.addEventListener("change", () => {
  if (shelf && librariesOf(shelf.room).includes(libWho.value)) openLibrary(shelf.room, libWho.value);
});
libQuery.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    const q = libQuery.value.trim().slice(0, MAX.title);
    if (!shelf || q === shelf.q) return;
    Object.assign(shelf, { q, titles: [], total: null });
    askLibrary(0);
    drawLibrary();
  }, FIND_PAUSE_MS);
});

addBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  if (active && files.length > 0) addFiles(active, files);
});
// A file dropped anywhere on the page is for the list, never a place to navigate to.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  side.classList.add("dragover");
});
window.addEventListener("dragleave", () => side.classList.remove("dragover"));
window.addEventListener("drop", (e) => {
  e.preventDefault();
  side.classList.remove("dragover");
  const files = [...(e.dataTransfer?.files ?? [])];
  if (active && files.length > 0) addFiles(active, files);
});

// What only time changes: a block that never came, a peer that never answered, a track
// that ran out, sound that drifted from the room, and the progress bar.
setInterval(() => {
  const now = performance.now();
  for (const [id, w] of pending) {
    if (now - w.at < WANT_TIMEOUT_MS) continue;
    pending.delete(id);
    strikes.set(w.peer, now + STRIKE_MS);
  }
  for (const room of rooms.values()) {
    greet(room);
    moveOn(room);
  }
  pump();
  syncAudio();
  drawStates();
  drawPlayer();
}, 250);

drawHeader();
drawList();
drawPlayer();
app.ready();
