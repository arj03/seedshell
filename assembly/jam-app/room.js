// A jam room, as a node in it keeps it: what the room agrees on, who else is jamming there,
// and the audio this node holds for it. Nothing here draws or sounds. Jam's view (ui.js) is
// this with a page in front, and the radio's head (radio-app/head.js) this with a directory
// of music behind it, so a node with no page keeps a room the way one with a page does.
//
// Plain script, put behind formats.js and the door to the app's own guest, which a view is
// given by assembly/view-lib/app.js and a head by node/shell.mjs:
//   app.cast(room, ...)            a frame to every linked member of a room
//   app.tell(room, to, ...)        a frame to one member of it
//   app.call([3], bytes)           hash: what a block of these bytes is called, answered
// The guest is guest-lib/room-pipe.js, and what jam's guest.js adds to it.
//
// A FRAME names its room, which is the pipe's to read, and then is [type u8][body]. One
// carries what the room agrees on, three move audio, and four are about a library:
//   1 DOC    JSON, a part of the room's state (below), or all of it
//   2 WANT   block ids, 32 bytes each: send me these
//   3 NACK   block ids: I do not have these
//   4 BLOCK  the bytes of one block
//   5 FIND   JSON { q, from }: the titles in your library that match these words
//   6 FOUND  JSON { q, from, total, titles: [{ path, size }] }: these, of that many
//   7 PICK   JSON { path, id }: put this title in the room's list, as the track `id`
//   8 MISS   JSON { id, why }: it was not put there, and why
//
// THE ROOM'S STATE is one document, and every change to it is a smaller document of the
// same shape, merged the same way whoever it comes from and however often:
//   msgs    [{ by, id, n, at, text }]         added, never changed
//   reacts  [{ t, e, by, on, n }]             per (target, emoji, peer), the latest `n` wins
//   tracks  [{ id, by, n, title, codec, rate, ch, size, head, blocks, lens, pre, pos, gone, v, vBy }]
//                                             what a track is never changes; where it sits
//                                             (`pos`) goes to the latest (v, vBy), and
//                                             `gone` once set stays set
//   play    { v, by, id, pos, on }            what is playing, the latest (v, by) wins
// `n` and `v` are a clock the room shares: each change takes one more than the highest this
// node has seen. So a newcomer is caught up by being sent the state, a peer that hears a
// change twice is unchanged by the second, and two that change the same thing at once end
// up agreeing on one of them. Four more fields are about the sender rather than the room:
// `hello` asks for the state, `synced` ends an answer to that, `have` lists the tracks
// the sender holds every block of, and `library` is how many titles it has a library of.
//
// Nothing here is signed. A frame is attributed by the channel it arrived on, and the guest
// passes on only those from members of the room, so the state is the members' to write:
// any of them may reorder the list, and what one relays of another's is its own word.
//
// AUDIO is the file's own bytes, never a copy made of them. A FLAC or Ogg Vorbis file is cut
// where its format lets a piece be decoded without the rest (formats.js), and each piece is
// a block, named by the BLAKE2b-256 of its bytes. A track lists its blocks, how many samples
// each holds (`lens`), the block every piece is decoded behind (`head`), and for Ogg Vorbis
// how much of the piece before goes in front of each when it is decoded (`pre`). So a block
// needs no trust in who sent it: our guest hashes what arrives, and one that is not the
// block asked for is not kept. Whoever added a track serves it from the file on disk, and
// everyone who has fetched a track serves it too.
//
// A LIBRARY is more music than a list is for: files a node has and no room has heard of,
// each a title, named by its path among them. A member asks a node what its library holds
// (FIND), a page at a time, and picks a title out of it (PICK). The node that has the file
// cuts it as any added file is cut, and puts it in the room's list as a track of its own,
// under the id the picker chose, which is how the picker knows it when it comes.
const ASK_HASH = 3;
const DOC = 1, WANT = 2, NACK = 3, BLOCK = 4, FIND = 5, FOUND = 6, PICK = 7, MISS = 8;

/** The largest file taken. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** How many of a file's pieces are read and named at once. */
const NAMING = 8;
/** A peer that has not answered `hello` is asked again after this long, and this many times. */
const HELLO_RETRY_MS = 3000;
const HELLO_TRIES = 20;
/** A state answer is cut into documents of about this many characters. */
const DOC_CHARS = 200000;
/** The most a room keeps, and the longest a peer's text is taken. */
const MAX = { msgs: 300, text: 2000, tracks: 500, blocks: 4096, title: 160, emoji: 24, emojis: 40, path: 1024 };

// ── bytes ───────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();
/** Block ids as they ride in a WANT or a NACK, back to hex. */
function idsOf(body) {
  const out = [];
  for (let o = 0; o + 32 <= body.length; o += 32) out.push(toHex(body.subarray(o, o + 32)));
  return out;
}
const randomHex = (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
/** What a frame that rides as JSON says, or null for one that says nothing readable. */
function jsonOf(body) {
  try {
    const said = JSON.parse(dec.decode(body));
    return said && typeof said === "object" ? said : null;
  } catch { return null; }
}

// What a peer sends is read as what it claims to be only once it has that shape.
const isHex = (v, bytes) => typeof v === "string" && v.length === bytes * 2 && /^[0-9a-f]*$/.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const listOf = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
/** Whether the change (v, by) is later than (v0, by0): the clock, then the key. */
const later = (v, by, v0, by0) => v > v0 || (v === v0 && by > by0);

/** What a file at `path` is called: its name, less its extension. */
const leafOf = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") || path;

function fmtSize(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// ── our guest ───────────────────────────────────────────────────────────
const castDoc = (room, doc) => app.cast(room.id, [DOC], enc.encode(JSON.stringify(doc)));
/** Tell one member what rides as JSON: a document, or a word about a library. */
const tellJson = (room, to, type, said) => app.tell(room.id, to, [type], enc.encode(JSON.stringify(said)));
const tellDoc = (room, to, doc) => tellJson(room, to, DOC, doc);

/** What a block of `bytes` is called. Our guest's to say, so the program in front of it and
 *  the guest never name one block two ways. */
const hashOf = (bytes) => app.call([ASK_HASH], bytes).then(toHex);

// ── who, and where ──────────────────────────────────────────────────────
// All of it the shell's, heard in the context: this node's key and nick, who is linked, and
// the rooms this node is in. What each peer is called is the door's (`app.nameOf`).
let me = "";
let myNick = "";
let linked = new Set();
/** The rooms this node is in, by id in hex. */
const rooms = new Map();

/** The blocks this node holds, by id in hex, whatever room wants them: a slice of a file
 *  it was given, or bytes a peer sent. */
const store = new Map();

/** What the program in front of this member sets:
 *
 *    jam.changed(room, changed, from)   a room here changed: `changed` is what `merge`
 *                                       answered, and `from` the peer whose document it
 *                                       was, or nothing for a change of this node's own
 *    jam.library                        how many titles this node has a library of, which
 *                                       the room is told
 *
 *  One it leaves alone does nothing, and has no library. */
const jam = { changed: () => {}, library: 0 };

function newRoom(id) {
  return {
    id, name: "", members: new Set(),
    clock: 0,
    msgs: new Map(),      // key → { key, by, id, n, at, text }
    reacts: new Map(),    // target → emoji → peer → { on, n }
    tracks: new Map(),    // id → track; one with no `blocks` is known of and not yet described
    play: { v: 0, by: "", id: null, pos: 0, on: false, at: 0 },
    blocks: new Set(),    // every block id a track here lists: what this room may be asked for
    peers: new Map(),     // the linked members: key → { synced, asked, tries }
    holders: new Map(),   // track id → the peers that say they hold all of it
    libraries: new Map(), // the peers that say they have a library → how many titles
  };
}

// ── the room's state ────────────────────────────────────────────────────
/** The tracks in the list, in order. */
function liveTracks(room) {
  return [...room.tracks.values()].filter((t) => t.blocks && !t.gone)
    .sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
}
/** Whether this node holds every block of `t`. */
function whole(t) {
  if (!t.whole && t.blocks && store.has(t.head) && t.blocks.every((b) => store.has(b))) t.whole = true;
  return t.whole === true;
}
function holdersOf(room, id) {
  let set = room.holders.get(id);
  if (!set) room.holders.set(id, set = new Set());
  return set;
}
/** Whether `t` can be played here: this node holds all of it, or a linked member says it
 *  does. A member still being asked what it holds may hold it, so nobody has it only once
 *  every one has answered, or been given up on. */
function available(room, t) {
  if (whole(t)) return true;
  const holders = holdersOf(room, t.id);
  for (const [id, peer] of room.peers) {
    if (holders.has(id) || (!peer.synced && peer.tries < HELLO_TRIES)) return true;
  }
  return false;
}
/** The members jamming here besides this node: the linked ones that have answered. A
 *  room-mate that does not run this app is in the room and never answers. */
function jamming(room) {
  return [...room.peers].filter(([, peer]) => peer.synced).map(([id]) => id);
}
/** Where the room is in its track, in seconds. Below zero, the track has yet to begin. */
function playPos(room) {
  const p = room.play;
  return p.on ? p.pos + (performance.now() - p.at) / 1000 : p.pos;
}
function currentTrack(room) {
  const t = room.play.id ? room.tracks.get(room.play.id) : undefined;
  return t && t.blocks && !t.gone ? t : null;
}

/** Whether `t` describes a track: what it is called, how it is coded, and its pieces. */
function describes(t) {
  const n = Array.isArray(t.blocks) ? t.blocks.length : 0;
  return isHex(t.by, 32) && isCount(t.n) && typeof t.title === "string" && isCount(t.size)
    && (t.codec === "flac" || t.codec === "vorbis")
    && isCount(t.rate) && t.rate >= 8000 && t.rate <= 384000 && isCount(t.ch) && t.ch >= 1 && t.ch <= 8
    && isHex(t.head, 32) && n >= 1 && n <= MAX.blocks && t.blocks.every((b) => isHex(b, 32))
    && Array.isArray(t.lens) && t.lens.length === n && t.lens.every((len) => isCount(len) && len > 0 && len <= t.rate * 60)
    && (t.pre === undefined || (Array.isArray(t.pre) && t.pre.length === n && t.pre.every((p) => isCount(p) && p <= 0x100000)));
}

/** Merge a document into the room's state, and answer what changed, for whatever is in
 *  front (`jam.changed`). The same for this node's own change, a peer's, and a whole state:
 *  nothing here depends on who sent it or how often.
 *
 *    msgs      the keys of the messages added
 *    added     the ids of the tracks described
 *    reacts    the targets whose reactions changed
 *    list      whether the list did: a track added, removed or moved
 *    play      whether what is playing did
 *    gone      the tracks removed, and `freed` the blocks let go of with them
 *    trimmed   the keys of the messages dropped for being the oldest of too many
 *    peers     whether what a peer says of itself did (`onDoc`) */
function merge(room, doc) {
  const changed = { msgs: [], added: [], reacts: new Set(), list: false, play: false, gone: [], freed: [], trimmed: [], peers: false };
  const seen = (n) => { if (n > room.clock) room.clock = n; };

  for (const m of listOf(doc.msgs, MAX.msgs)) {
    if (!m || !isHex(m.by, 32) || !isHex(m.id, 8) || !isCount(m.n) || typeof m.text !== "string" || m.text === "") continue;
    seen(m.n);
    const key = `m:${m.by}:${m.id}`;
    if (room.msgs.has(key)) continue;
    room.msgs.set(key, { key, by: m.by, id: m.id, n: m.n, at: isCount(m.at) ? m.at : 0, text: m.text.slice(0, MAX.text) });
    changed.msgs.push(key);
  }

  for (const r of listOf(doc.reacts, 4096)) {
    if (!r || typeof r.t !== "string" || r.t.length > 90 || typeof r.e !== "string" || r.e === ""
      || r.e.length > MAX.emoji || !isHex(r.by, 32) || !isCount(r.n)) continue;
    seen(r.n);
    let byEmoji = room.reacts.get(r.t);
    if (!byEmoji) room.reacts.set(r.t, byEmoji = new Map());
    let byPeer = byEmoji.get(r.e);
    if (!byPeer) {
      if (byEmoji.size >= MAX.emojis) continue;
      byEmoji.set(r.e, byPeer = new Map());
    }
    const had = byPeer.get(r.by);
    if (had && had.n >= r.n) continue;
    byPeer.set(r.by, { on: r.on === true, n: r.n });
    changed.reacts.add(r.t);
  }

  for (const t of listOf(doc.tracks, MAX.tracks)) {
    if (!t || !isHex(t.id, 8) || !isCount(t.v) || !isHex(t.vBy, 32)) continue;
    seen(t.v);
    let have = room.tracks.get(t.id);
    if (!have) {
      // A full room forgets the oldest track that was removed, and takes no more once
      // every one it knows of is still in the list.
      if (room.tracks.size >= MAX.tracks) {
        const oldest = [...room.tracks.values()].filter((o) => o.gone).sort((a, b) => a.v - b.v)[0];
        if (!oldest) continue;
        room.tracks.delete(oldest.id);
      }
      room.tracks.set(t.id, have = { id: t.id, blocks: null, pos: 0, gone: false, goneAt: 0, v: 0, vBy: "" });
    }
    // What a track is never changes, so the first description of it stands.
    if (!have.blocks && !have.gone && t.gone !== true && describes(t)) {
      seen(t.n);
      // Where each piece starts, in samples, and so how long the track is.
      const starts = [0];
      for (const len of t.lens) starts.push(starts[starts.length - 1] + len);
      Object.assign(have, {
        by: t.by, n: t.n, title: t.title.slice(0, MAX.title) || "untitled", size: t.size,
        codec: t.codec, rate: t.rate, ch: t.ch, head: t.head, blocks: t.blocks.slice(), lens: t.lens.slice(),
        pre: t.pre ? t.pre.slice() : null, starts, dur: starts[starts.length - 1] / t.rate,
      });
      room.blocks.add(have.head);
      for (const b of have.blocks) room.blocks.add(b);
      changed.added.push(t.id);
      changed.list = true;
    }
    if (t.gone === true && !have.gone) {
      have.gone = true;
      have.goneAt = performance.now();
      changed.gone.push(have);
      changed.freed.push(...forgetTrack(have, room));
      changed.list = true;
    }
    if (later(t.v, t.vBy, have.v, have.vBy)) {
      if (typeof t.pos === "number" && Number.isFinite(t.pos)) have.pos = t.pos;
      have.v = t.v;
      have.vBy = t.vBy;
      changed.list = true;
    }
  }

  const p = doc.play;
  if (p && isCount(p.v) && isHex(p.by, 32) && (p.id === null || isHex(p.id, 8))
    && typeof p.pos === "number" && Number.isFinite(p.pos) && p.pos >= -60) {
    seen(p.v);
    if (later(p.v, p.by, room.play.v, room.play.by)) {
      room.play = { v: p.v, by: p.by, id: p.id, pos: p.pos, on: p.on === true, at: performance.now() };
      changed.play = true;
    }
  }

  // The oldest messages go once there are too many, and what was said of them.
  if (room.msgs.size > MAX.msgs) {
    const oldest = [...room.msgs.values()].sort((a, b) => a.n - b.n).slice(0, room.msgs.size - MAX.msgs);
    for (const m of oldest) {
      room.msgs.delete(m.key);
      room.reacts.delete(m.key);
      changed.trimmed.push(m.key);
    }
  }
  return changed;
}

/** A track as it rides in a document. One that is gone, or not yet described, is its id
 *  and where it stands. */
function wireTrack(t) {
  if (!t.blocks || t.gone) return { id: t.id, pos: t.pos, gone: t.gone, v: t.v, vBy: t.vBy };
  return { id: t.id, by: t.by, n: t.n, title: t.title, codec: t.codec, rate: t.rate, ch: t.ch, size: t.size,
    head: t.head, blocks: t.blocks, lens: t.lens, ...(t.pre ? { pre: t.pre } : {}),
    pos: t.pos, gone: false, v: t.v, vBy: t.vBy };
}

/** The room's whole state, as the documents a newcomer is sent: cut so no frame is large,
 *  with what is playing, what this node holds, the library it has, and `synced` in the
 *  last. */
function stateDocs(room) {
  const docs = [];
  let doc = {}, chars = 0;
  const put = (field, item) => {
    const size = JSON.stringify(item).length;
    if (chars > 0 && chars + size > DOC_CHARS) { docs.push(doc); doc = {}; chars = 0; }
    (doc[field] ??= []).push(item);
    chars += size;
  };
  for (const { by, id, n, at, text } of room.msgs.values()) put("msgs", { by, id, n, at, text });
  for (const [t, byEmoji] of room.reacts) {
    for (const [e, byPeer] of byEmoji) for (const [by, r] of byPeer) put("reacts", { t, e, by, on: r.on, n: r.n });
  }
  for (const t of room.tracks.values()) put("tracks", wireTrack(t));
  const p = room.play;
  // Where the room is NOW, since the reader starts its own clock when this arrives.
  if (p.v > 0) doc.play = { v: p.v, by: p.by, id: p.id, pos: playPos(room), on: p.on };
  doc.have = liveTracks(room).filter(whole).map((t) => t.id);
  if (jam.library > 0) doc.library = jam.library;
  doc.synced = true;
  docs.push(doc);
  return docs;
}

/** Make a change of this node's own: here first, then to the room. */
function apply(room, doc) {
  jam.changed(room, merge(room, doc));
  castDoc(room, doc);
}

/** A peer's document. What it says of the room is merged; what it says of itself is kept
 *  beside the room, under the key the channel gave. */
function onDoc(room, from, doc) {
  const changed = merge(room, doc);
  if (Array.isArray(doc.have)) {
    for (const id of listOf(doc.have, MAX.tracks)) if (isHex(id, 8)) holdersOf(room, id).add(from);
    changed.peers = true;
  }
  if (isCount(doc.library)) {
    if (doc.library > 0) room.libraries.set(from, doc.library);
    else room.libraries.delete(from);
    changed.peers = true;
  }
  const peer = room.peers.get(from);
  if (doc.synced === true && peer && !peer.synced) {
    peer.synced = true;
    changed.peers = true;
  }
  jam.changed(room, changed, from);
  if (doc.hello === true) {
    for (const d of stateDocs(room)) tellDoc(room, from, d);
    // It runs this app after all, so it is worth asking again.
    if (peer && !peer.synced) { peer.tries = 0; greet(room); }
  }
}

/** Ask each linked member that has not answered for the room's state. A member is asked
 *  until it answers, since it may not yet have heard that this node is in the room. */
function greet(room) {
  const now = performance.now();
  for (const [id, peer] of room.peers) {
    if (peer.synced || peer.tries >= HELLO_TRIES || now - peer.asked < HELLO_RETRY_MS) continue;
    peer.asked = now;
    peer.tries++;
    tellDoc(room, id, { hello: true });
  }
}

/** Every block a track still in a list names, in any room here, but `t`'s. */
function keptBlocks(t) {
  const kept = new Set();
  for (const r of rooms.values()) {
    for (const other of r.tracks.values()) {
      if (other === t || !other.blocks || other.gone) continue;
      kept.add(other.head);
      for (const b of other.blocks) kept.add(b);
    }
  }
  return kept;
}

/** Let go of a track's audio: each block no track still in a list names. Answers them. */
function forgetTrack(t, room) {
  t.whole = false;
  room.holders.delete(t.id);
  if (!t.blocks) return [];
  const kept = keptBlocks(t);
  const freed = [t.head, ...t.blocks].filter((b) => !kept.has(b));
  for (const b of freed) {
    store.delete(b);
    for (const r of rooms.values()) r.blocks.delete(b);
  }
  return freed;
}

/** Leave a room, letting go of the audio no room still here names, all of it at once. */
function leaveRoom(room) {
  rooms.delete(room.id);
  const kept = keptBlocks(null);
  for (const b of room.blocks) if (!kept.has(b)) store.delete(b);
}

// ── this node's own changes ─────────────────────────────────────────────
function setPlay(room, id, pos, on) {
  apply(room, { play: { v: ++room.clock, by: me, id, pos, on } });
}

/** Whether this node is the one to move the room on when a track ends: the highest key
 *  there. The others wait a little, and take over only if it does not. */
function leads(room) {
  return jamming(room).every((id) => id < me);
}

/** Move the room on once its track is over, gone from the list, or had by nobody here, to
 *  the next one someone has. Every node works this out from the same state, so they agree
 *  on what is next; they say so one after another rather than all at once. */
function moveOn(room) {
  const p = room.play;
  if (!p.on || !p.id) return;
  // A track this node has not heard of yet is not one it can say is over: a newcomer is
  // told what is playing before it has the whole list.
  const t = room.tracks.get(p.id);
  if (!t || (!t.blocks && !t.gone)) return;
  const now = performance.now();
  const over = t.gone ? (now - Math.max(p.at, t.goneAt)) / 1000
    : !available(room, t) ? (now - p.at) / 1000
    : playPos(room) - t.dur;
  if (over < (leads(room) ? 0.25 : 2.5)) return;
  const next = liveTracks(room).find((o) => (o.pos > t.pos || (o.pos === t.pos && o.id > t.id)) && available(room, o));
  if (next) setPlay(room, next.id, 0, true);
  else setPlay(room, null, 0, false);
}

// ── audio in: files ─────────────────────────────────────────────────────
/** Cut a file where its format allows (formats.js) and name its pieces, keeping none of
 *  them yet: { ix, head, pieces }, the head and each piece { id, part }. A piece's
 *  part is a slice of the file, read when a peer asks for it, so what a peer is sent is the
 *  file's own bytes. A `file` is its `size` and any `slice(start, end)` of it, each with an
 *  `arrayBuffer()`: a File a page was given, or one a head reads from disk.
 *
 *  `progress` hears how far the work has come, from 0 to 1: half of it is finding where to
 *  cut, and half naming the pieces. `proves` is asked whether the file plays the way it was
 *  cut, by whoever can tell, and throws if it does not. Throws, saying why, for a file that
 *  cannot be cut. */
async function cutFile(file, { progress = () => {}, proves = async () => {} } = {}) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`it is over ${fmtSize(MAX_FILE_BYTES)}`);
  const ix = await indexAudio(file, (part) => progress(part / 2));
  if (ix.cuts.length > MAX.blocks) throw new Error("it is too long");
  await proves(ix);
  const head = { id: await hashOf(ix.head), part: new Blob([ix.head]) };
  // Several pieces at once, each read and named in its own place, so one waits on no other's
  // round trip to the guest.
  const pieces = new Array(ix.cuts.length);
  let next = 0, done = 0;
  const nameNext = async () => {
    while (next < ix.cuts.length) {
      const i = next++;
      const part = file.slice(ix.cuts[i].start, ix.cuts[i].end);
      pieces[i] = { id: await hashOf(new Uint8Array(await part.arrayBuffer())), part };
      progress(0.5 + ++done / ix.cuts.length / 2);
    }
  };
  await Promise.all(Array.from({ length: NAMING }, nameNext));
  return { ix, head, pieces };
}

/** Put a file in the room's list, as the track `id`, at the list's end: cut (`cutFile`,
 *  which takes `progress` and `proves`) and left where it is, as it is. `name` is what the
 *  track is called if the file's tags do not say. Throws, saying why, for a file that
 *  cannot be added. */
async function addTrack(room, id, file, name, how) {
  if (liveTracks(room).length >= MAX.tracks) throw new Error("the list is full");
  const { ix, head, pieces } = await cutFile(file, how);
  if (rooms.get(room.id) !== room) return;   // the room was left meanwhile
  for (const block of [head, ...pieces]) store.set(block.id, block.part);
  const n = ++room.clock;
  const last = Math.max(0, ...[...room.tracks.values()].map((t) => t.pos));
  const { title, artist } = ix.tags;
  apply(room, {
    tracks: [{
      id, by: me, n, size: file.size,
      title: title ? (artist ? `${artist} – ${title}` : title) : name,
      codec: ix.codec, rate: ix.rate, ch: ix.channels, head: head.id, blocks: pieces.map((p) => p.id), lens: ix.cuts.map((c) => c.samples),
      ...(ix.codec === "vorbis" ? { pre: ix.cuts.map((c) => c.pre) } : {}),
      pos: last + 1, gone: false, v: n, vBy: me,
    }],
    have: [id],
  });
}

// ── audio across: blocks ────────────────────────────────────────────────
/** Send a member the blocks it asked for, of the ones a track in this room lists: all read
 *  at once, and sent in the order asked. */
async function serve(room, from, ids) {
  const asked = ids.slice(0, 16);
  const read = await Promise.all(asked.map(async (id) => {
    const blob = room.blocks.has(id) ? store.get(id) : undefined;
    try { return blob ? new Uint8Array(await blob.arrayBuffer()) : null; }
    catch { return null; }   // its file can no longer be read
  }));
  const lacking = asked.filter((id, i) => !read[i]);
  for (const bytes of read) if (bytes) app.tell(room.id, from, [BLOCK], bytes);
  if (lacking.length > 0) app.tell(room.id, from, [NACK], fromHex(lacking.join("")));
}

// ── what the shell hands us ─────────────────────────────────────────────
/** The node's context. Its rooms are ours to keep a state for, and each one's linked
 *  members are who that state is shared with. Answers the rooms this node is newly in and
 *  the ones it has left, for whatever is in front to make room for or clear away. */
function memberContext(ctx) {
  me = ctx.me;
  myNick = ctx.nick;
  linked = new Set(ctx.linked);
  const ids = new Set(ctx.rooms.map((r) => r.id));
  const left = [...rooms.values()].filter((room) => !ids.has(room.id));
  for (const room of left) leaveRoom(room);
  const joined = [];
  for (const r of ctx.rooms) {
    let room = rooms.get(r.id);
    if (!room) {
      rooms.set(r.id, room = newRoom(r.id));
      joined.push(room);
    }
    room.name = r.name;
    room.members = new Set(r.members);
    // A member that is no longer linked takes what it said of itself with it: when it is
    // back it is asked again, and says again what it holds.
    const there = (id) => linked.has(id) && room.members.has(id);
    for (const id of [...room.peers.keys()]) {
      if (there(id)) continue;
      room.peers.delete(id);
      for (const [track, set] of room.holders) {
        set.delete(id);
        if (!set.size) room.holders.delete(track);
      }
    }
    for (const id of [...room.libraries.keys()]) if (!there(id)) room.libraries.delete(id);
    for (const id of room.members) {
      if (id !== me && linked.has(id) && !room.peers.has(id)) room.peers.set(id, { synced: false, asked: -Infinity, tries: 0 });
    }
    greet(room);
  }
  return { joined, left };
}

/** A peer's frame of a kind every member answers: a part of the room's state, or a want.
 *  The rest are for whatever is in front: a view fetches audio and asks a library, and a
 *  node with a library answers for it. */
function memberFrame(room, from, frame) {
  const body = frame.subarray(1);
  if (frame[0] === DOC) {
    const doc = jsonOf(body);
    if (doc) onDoc(room, from, doc);
  } else if (frame[0] === WANT) void serve(room, from, idsOf(body));
}
