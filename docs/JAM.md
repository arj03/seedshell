# seedshell: jam and the radio

How jam keeps a room's chat and playlist, and moves its audio, and how the radio keeps a
jam room from a node with no page. The [README](../README.md#the-radio) says how to start one.

## Jam

A room's chat, emoji reactions on what is said, and a playlist the room keeps and plays
together. It follows [seedstore](https://github.com/arj03/seedstore)'s split into two
planes: small frames that say what the room agrees on, and blocks of audio that are named
by their hash and so need no trust in whoever sent them.

**A frame** is the room pipe's, `[room 32][type u8][body]`, under the protocol id `jam`.

| `type` | Body | For |
| --- | --- | --- |
| `1` DOC | JSON | A part of the room's state, or all of it |
| `2` WANT | block ids, 32 bytes each | Send me these blocks |
| `3` NACK | block ids | I do not have these |
| `4` BLOCK | the bytes of one block | A block that was asked for |
| `5` FIND | JSON `{ q, from }` | The titles in your library that match these words |
| `6` FOUND | JSON `{ q, from, total, titles }` | These, of that many |
| `7` PICK | JSON `{ path, id }` | Put this title in the room's list, as the track `id` |
| `8` MISS | JSON `{ id, why }` | It was not put there, and why |

**The guest** is the room pipe (`guest-lib/room-pipe.js`), which reads the room of every
frame: one its view *casts* goes to the linked members of the frame's room, one it *tells*
goes to a single member, and a peer's frame is passed to the view only if the relay lists
its sender in that room. `jam-app/guest.js` adds what a block is called. A BLOCK is hashed
on the way in, so its render (`[2][from 32][room 32][id 32][bytes]`) carries the id this
node's own guest gave those bytes, never the one the sender claimed. The view also asks it
to name the blocks of a file being added (`[3][bytes]`, answered with the id), so the two
never name a block two ways.

**A member** of a room is `jam-app/room.js`: what the room agrees on, who else is jamming
there, and the audio this node holds for it, with nothing drawn or sounded. The view
(`jam-app/ui.js`) is that with a page in front of it, and adds what only a listener does:
fetching the audio the room is playing, and sounding it. A node with no page keeps a room
with the same file, which is what [the radio](#the-radio) is.

**The room's state** is the member's, and is one document:

```
msgs    [{ by, id, n, at, text }]      added, never changed
reacts  [{ t, e, by, on, n }]          per (target, emoji, peer), the latest n wins
tracks  [{ id, by, n, title, codec, rate, ch, size, head, blocks, lens, pre,
           pos, gone, v, vBy }]        what a track is never changes; pos goes to the
                                       latest (v, vBy); gone, once set, stays set
play    { v, by, id, pos, on }         what is playing: the latest (v, by) wins
```

Every change is a smaller document of the same shape, merged the same way whoever sent it
and however often. `n` and `v` are a clock the room shares: a change takes one more than
the highest its author has seen. So a newcomer is caught up by being sent the state, a
change heard twice changes nothing the second time, and two peers that move the same track
at once end up agreeing on one of the moves. A node asks each linked member for the state
when it first sees it (`hello`), which is also what brings a reloaded tab back. The answer
ends with what the member says of itself: the tracks it holds all of (`have`), and how many
titles it has a library of (`library`), if it has one.

**Audio** is the file's own bytes: nothing is re-encoded, on the way in or on the way
out. A file is cut into pieces that each decode without the rest (`jam-app/formats.js`),
of at most 256 KB or five seconds, and each piece is a block, named by the SHA-256 of
its bytes.

- A **FLAC** file is a header and then frames, and every frame decodes on its own, so a
  piece is whole frames. A frame does not say how long it is: it ends where the next
  begins, which is found by the next one's sync code and header and proved by the CRC-16
  the frame ends with, since audio can hold bytes that read as a header.
- An **Ogg Vorbis** file is pages, each saying how long it is and how many samples the
  stream has reached, so a piece is whole pages, cut where no packet runs over. A Vorbis
  packet is decoded against the one before it, so a piece is decoded with the last page of
  the piece before it in front (`pre`), and the samples that page yields are dropped.

A track lists its blocks, how many samples each holds (`lens`), and one more block that
every piece is decoded behind (`head`): FLAC's STREAMINFO, or Vorbis's three header
packets. Whoever added a track serves it from the file on disk, a slice at a time, and
everyone who has fetched a track serves it too, so the one who added it can leave. Blocks
are asked of any member that says it holds the track (`have`), a few at a time, and one
that does not arrive is asked for again, of someone else if there is anyone.

A track is a file to keep, too: **Download** on its row fetches whatever of it is not
here yet, listening or not, and saves the head and then the pieces, end to end. The audio
is the bytes that were added. An Ogg Vorbis track comes out as the file itself. A FLAC
track comes out as the file's frames behind a STREAMINFO that says how long the stream is,
without the tags and pictures the file carried, which no peer was sent.

**Playing** is the room's, and listening is each node's own. `play` says which track,
from where, and whether it is running, so play, pause, seek and skip are for everyone. A
node that has tuned in asks first for the piece the room has reached, then the ones after
it, and needs only those to sound: it comes in anywhere in a track as readily as at its
start. Each piece is decoded by Web Audio into the samples it holds and set down on the
audio clock at the sample the one before it stopped at, in a context that runs at the
track's own sample rate. Decoded that way a piece is the same samples a decode of the
whole file gives, and a node holds a few seconds of them however long the track. One that
has not tuned in sees what is on and is nudged. When a track ends each node works out the
next from the same list, and the one with the highest key says so first. A track nobody
here holds, once every member has said what it holds, cannot be started and is passed
over: one that is on when the last node holding it goes is over then.

**Buffering.** The room's clock does not stop for a node whose blocks are slow, so a node
does not start sounding until it will not run dry. It measures how fast blocks have been
arriving and counts on four fifths of that.

- *Faster than the track plays*, it starts once it holds four seconds ahead of the room,
  which is what carries it over a link that stutters. From then on its lead only grows: it
  goes on to fetch the rest of the track, and the one after it.
- *Slower than the track plays*, sound started at once would stall. So it works out how
  much it must hold for the rest to arrive in time, aims at the place in the track where
  the room will be when it holds that much, and asks for pieces from there rather than
  ones the room will have passed. It says when it will join, and from there plays to the
  end of the track without a break.

Until a block has arrived there is nothing to measure, so a node asks for little at first:
what is asked for cannot be called back, and a slow link has to deliver all of it before
anything asked for after. A peer that is still delivering is not given up on for being
slow. And a track someone starts begins a second and a half later when not everyone holds
it yet, so that the others have its opening by the time it sounds.

**A library** is more music than a list is for: files a member has that no room has heard
of, each a *title*, named by its path among them. A member that has one says how many
titles it holds, and the list's **Library** button opens it in the list's place. What is
typed there is asked of that member (FIND), which answers a page of the titles whose path
holds every word (FOUND). Playing one, or adding it to the list, is asked of it too (PICK),
with an id the asker chose: the member that has the file cuts it as any added file is cut,
and adds the track to the room's list as its own, under that id, which is how the asker
knows it when it comes. One it cannot add it says so of (MISS). Jam's view asks a library
and has none; the radio has one. The radio keeps nothing between runs, so for a track in
the list it does not hold it takes a title of the size the track says its file was, and
holds the track again at once. The file is cut when its audio is first asked for, and a
block it does not name is refused, so whoever asked looks elsewhere. Started again on its
directory, the radio serves what it added before.

What it does not do:

- **Nothing is signed.** A frame is attributed by the channel it arrived on, and only
  members of a room are heard, so the state is the members' to write. What one member
  relays of another's messages is its own word for them.
- **Nothing is kept.** The room's state and its audio live in the page, so they last as
  long as someone in the room stays. A tab that reloads gets both back from the others; a
  room everyone has left is empty when they return, unless a radio stayed in it.
- **Only FLAC and Ogg Vorbis.** They are the two formats it knows how to cut. A file of
  another kind is refused rather than converted: MP3, AAC and Opus could each be cut too,
  and are not yet. A file is at most 512 MB.
- **The room does not wait for a slow node.** One whose blocks come slower than a track
  plays cannot hear all of it, whatever it does. It hears the later part of each track,
  unbroken, rather than all of it in pieces.

## The radio

A member of a jam room with no page: a Node process that keeps a room as a tab does, with a
directory of music behind it for the room to play from. A peer need not be a browser, and
jam's view cannot tell the radio from a tab, but that it says it has a library.

```sh
npm run radio -- <music directory> --relay <ws://<relay key>.<secret>@host:port> [--room <name>]
                 [--relay-secret <secret>] [--nick <name>] [--key <file>]
```

The room is `global` unless named, as a tab of the shell's is by default. The relay's
address names its key, as the relay prints it when it starts. It needs Node 22 or later, whose WebSocket it dials the
relay with.

**The headless shell** (`node/shell.mjs`) is the page less what only a person at one has a
use for. It holds the node's identity and nick, the relay, its rooms and who is in them,
and the links to them, and hosts one app; it has no contacts, takes no offers and holds no
calls. The app is a signed bundle like any other, admitted because whoever started the
node named it, and its guest is driven through the same two ops as a page's. Where a view
would stand is a *head*: plain script the shell runs, with the same door to the guest a
view is given (`app.call`, `app.cast`, `app.tell`, `app.onFrame`, `app.onContext`). A head
is the node's own program and is not confined. It reaches what it is handed beside the
door, which is how the radio's comes by a directory.

**The radio app** (`assembly/radio-app/`) is a bundle of its own, under its own label,
which claims `jam` and whose guest is jam's: it speaks jam's protocol as jam does, and on a
node it stands where jam would, since a claim has one holder. It has no view and no
module. Its head (`head.js`) runs behind jam's `formats.js` and `room.js`, so it keeps a
room the way a tab does: it answers a newcomer with the room's state, serves the audio it
holds, and moves the room on when a track ends. A room it is in is still there, its chat
and its list, when the last tab has closed. It listens to nothing, and so fetches nothing:
a track a tab added is that tab's to serve, and theirs who have played it.

**Its library** is every FLAC and Ogg Vorbis file under the directory, walked once when it
starts, each a title named by its path ([A library](#jam) is how a member asks one).
A path a peer names is looked up among the titles and never opened as it stands, and a
symbolic link is not followed. Titles are cut one at a time, and only so many may wait.
The radio keeps nothing between runs but its key (`radio.key`), so it is the same peer when
started again, and it finds the files of the tracks the room lists again by their size.

What it says of its rooms on the console, a nick or a track's title among it, is printed
with no control characters, since a peer chose them and a terminal acts on them.

What it does not do:

- **No direct links.** Node has no WebRTC, so a link between the radio and a tab stays on
  the relay, which forwards its encrypted bytes. seedkernel's UDP path reaches only other
  console nodes, and the headless shell does not use it.
- **One app.** A headless shell hosts the app it was started with, and nothing else.

## Troubleshooting

- **Jam shows what is playing, with no sound.** Press **Tune in**: listening is each
  node's own choice, and a browser lets a page make sound only after a click in it.
- **Jam says `Not connected to a room`, or `Nobody else is connected here yet`.** Music is
  added to a room, for whoever else is in it. Join one on the **Network** tab. With a room
  and nobody else linked in it, music can still be added: whoever joins is sent the list,
  and fetches the audio from this node.
- **A track says `nobody here has it`.** Its audio is held by whoever added it and by
  everyone who has played it since. If they have all left or reloaded, the entry is still
  in the list and its audio is gone, so it cannot be played and the room skips it: remove
  it and add the file again. It also comes back when a radio with its file in its
  directory is in the room, whoever added it: so restarting a radio brings back what it
  added.
