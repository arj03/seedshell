// The radio's head: a member of a jam room with no page, and a library behind it. It keeps
// the rooms it is in as any member does (jam-app/room.js): it answers a newcomer with the
// room's state, serves the audio it holds, and moves the room on when a track ends. So a
// room it is in is still there when the last tab has closed, with its chat and its list.
// It listens to nothing, and so fetches nothing: what a member adds from a file of its own
// is that member's to serve, and theirs who have played it.
//
// What it adds is its LIBRARY: every title it was handed, of which a room has heard only
// how many there are. A member asks which match what someone typed (FIND) and is told a
// page of them (FOUND), and asks for one to be put in its room's list (PICK). The radio
// cuts that file as jam's view cuts one a person adds, and adds the track as its own,
// under the id the picker chose; one it cannot add it says so of (MISS).
//
// Plain script, the head of radio-app's bundle, which has no view: a headless shell
// (node/shell.mjs) runs it behind jam-app/formats.js and jam-app/room.js, with the door to
// the bundle's guest, which is jam's, and with the one thing the radio is handed:
//
//   music.titles()     the library, [{ path, size }]: each title by its path in it
//   music.open(path)   that title's file: its `size`, and any `slice(start, end)` of it,
//                      each with an `arrayBuffer()`, read when it is asked for
//
// A title is a file, and its path is all that is known of it until it is picked: its tags
// are read when it is cut. So a library is as large as the directory, at no cost but the
// walk through it.
//
// The radio keeps nothing between runs, so a track it added before it was last started is
// one it no longer holds. It finds the file again by the track's size, and holds the track
// again at once: the file is cut when a block of it is first asked for, and a block it does
// not name is not served, so whoever asked for it asks elsewhere.
//
// Peers are strangers. A path a peer names is looked up among the titles and never opened
// as it stands, and the titles waiting to be cut are few, since cutting one reads all of it.

/** How many titles one FOUND carries. */
const PAGE = 50;
/** The titles that may be waiting to be cut at once. A pick past that is turned down. */
const MAX_WAITING = 32;

/** The library: every title, in the order `music` gave them, each with its path as it is
 *  matched against, and the same titles by path. */
let titles = [];
const byPath = new Map();
/** The titles by their file's size, to find a track's file among them (`reclaim`). */
const bySize = new Map();

const who = (id) => (id === me ? myNick : nicks.get(id)) || id.slice(0, 8);
/** What happens in a room, said on the console. A nick or a title is a peer's word, and may
 *  hold control characters, which a terminal acts on: none are printed. */
const say = (room, text) => console.log(`#${room.name}: ${text}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ""));

/** A member asks what the library holds that matches every word of `q`, from the `from`th
 *  such title on. No words is all of it. */
function onFind(room, from, ask) {
  const q = typeof ask.q === "string" ? ask.q.slice(0, MAX.title) : "";
  const start = isCount(ask.from) ? ask.from : 0;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = words.length === 0 ? titles : titles.filter((t) => words.every((word) => t.lower.includes(word)));
  tellJson(room, from, FOUND, {
    q, from: start, total: found.length,
    titles: found.slice(start, start + PAGE).map(({ path, size }) => ({ path, size })),
  });
}

/** A member asks for a title in its room's list, as the track `id`. Titles are cut one at
 *  a time, in the order they were asked for. */
let cutting = Promise.resolve();
let waiting = 0;
function onPick(room, from, ask) {
  if (!isHex(ask.id, 8) || typeof ask.path !== "string") return;
  const miss = (why) => tellJson(room, from, MISS, { id: ask.id, why });
  const title = byPath.get(ask.path);
  if (!title) { miss("it is not in this library"); return; }
  if (room.tracks.has(ask.id)) return;   // asked for twice
  if (waiting >= MAX_WAITING) { miss("too many titles are waiting to be added"); return; }
  waiting++;
  cutting = cutting.then(async () => {
    try {
      if (rooms.get(room.id) !== room || room.tracks.has(ask.id)) return;
      say(room, `${who(from)} picked ${title.path}`);
      const name = title.path.slice(title.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
      await addTrack(room, ask.id, await music.open(title.path), name || title.path);
    } catch (err) {
      say(room, `${title.path} was not added: ${err.message}`);
      miss(err.message);
    } finally { waiting--; }
  });
}

/** Hold `t` again if a title is the size its file was, and tell the room. Each of its blocks
 *  is read from that title's file, cut the first time any of them is asked for. */
function reclaim(room, t) {
  const title = bySize.get(t.size)?.[0];
  if (!title || !t.blocks || t.gone) return;
  let cut = null;
  const block = (id, of) => ({
    async arrayBuffer() {
      cut ??= music.open(title.path).then(cutFile);
      const piece = of(await cut);
      if (piece?.id !== id) throw new Error("not this track's file");
      return piece.part.arrayBuffer();
    },
  });
  store.set(t.head, block(t.head, (c) => c.head));
  t.blocks.forEach((id, i) => store.set(id, block(id, (c) => c.pieces[i])));
  say(room, `holds ${t.title} again, from ${title.path}`);
  castDoc(room, { have: [t.id] });
}

/** What a person watching the radio is told of a room: what was added, and what is on. A
 *  track it does not hold may be one it can hold again. */
jam.changed = (room, changed) => {
  for (const id of changed.added) {
    const t = room.tracks.get(id);
    say(room, `${who(t.by)} added ${t.title}`);
    if (!whole(t)) reclaim(room, t);
  }
  if (!changed.play) return;
  const t = currentTrack(room);
  say(room, !t ? "nothing is playing" : `${room.play.on ? "playing" : "paused in"} ${t.title}, ${who(room.play.by)}'s word`);
};

app.onContext((ctx) => {
  const { joined, left } = memberContext(ctx);
  for (const room of joined) say(room, "the radio is in this room");
  for (const room of left) say(room, "the radio has left this room");
});

/** A peer's frame, from a member of the room it names. What any member answers is
 *  room.js's; the two a library answers are here. */
app.onFrame((from, id, frame) => {
  const room = rooms.get(id);
  if (!room || frame.length < 1) return;
  if (frame[0] !== FIND && frame[0] !== PICK) { memberFrame(room, from, frame); return; }
  const ask = jsonOf(frame.subarray(1));
  if (ask) (frame[0] === FIND ? onFind : onPick)(room, from, ask);
});

// What only time changes: a peer that never answered, and a track that ran out.
setInterval(() => {
  for (const room of rooms.values()) {
    greet(room);
    moveOn(room);
  }
}, 250);

// The library is walked once. Until it has been, the radio is a member with none, and then
// every room it is in is told how many titles it has, and the tracks it has heard of are
// looked for among them.
music.titles().then((found) => {
  titles = found.filter((t) => t.path.length <= MAX.path).map(({ path, size }) => ({ path, size, lower: path.toLowerCase() }));
  for (const t of titles) {
    byPath.set(t.path, t);
    if (!bySize.has(t.size)) bySize.set(t.size, []);
    bySize.get(t.size).push(t);
  }
  jam.library = titles.length;
  console.log(`the library holds ${titles.length} title${titles.length === 1 ? "" : "s"}`);
  for (const room of rooms.values()) {
    castDoc(room, { library: jam.library });
    for (const t of room.tracks.values()) if (t.blocks && !whole(t)) reclaim(room, t);
  }
}, (err) => console.log(`the library could not be read: ${err.message}`));

app.ready();
