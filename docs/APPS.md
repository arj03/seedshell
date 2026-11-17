# seedshell: writing an app

What an app is made of, what it and the shell agree on, and how to build one. The
[README](../README.md) says how to run the shell; [ARCHITECTURE](ARCHITECTURE.md) says how
it holds an app to its consent row.

Anything the shell installs has the same parts, and `browser/app-api.js` is the whole of
what it and the shell agree on. Hello (`assembly/hello-app/`) is the least an app can be,
and the one to copy. Chat (`assembly/chat-app/`) is the reference for an app with a guest
of its own and a module. Jam (`assembly/jam-app/`) is one with no module, whose state lives
in its view and whose guest is little more than the room pipe.

Hello is an `app.json` and a page:

```json
{ "app": "hello", "api": 3, "ui": "ui.html" }
```

It names no guest, so its guest is the room pipe. Its view (`ui.js`) talks to the room
through one object, `app`: `onContext` for who and where, `cast` to a room, `onFrame` for
what the room's members cast, and `ready()` once it is listening. A cast goes to the linked
members of a room, a frame is heard only from a member of the room it names, and what a
room holds is the view's to keep.

To start another app, copy `assembly/hello-app/` beside it, give the copy a label of its
own (`app`), and run `npm run build`. Every directory under `assembly/` with an
`app.json` is signed into `bundle/<app>.skb`, the file to drop on the **Apps** tab of two
tabs in one room. The rest of this section is what those files stand on, for an app that
needs more.

## 1. `app.json`: what the bundle is

One file beside the app's sources. Every path in it is relative to it, and only `app` and
`api` must be there. Chat's:

```json
{
  "app": "chat",
  "api": 3,
  "name": "Chat",
  "version": "v2",
  "description": "text + images, rooms and direct chats",
  "guest": ["../guest-lib/net.js", "../guest-lib/context.js", "guest.js"],
  "ui": "ui.html",
  "modules": { "chat": "index.ts" }
}
```

| Field | Meaning |
| --- | --- |
| `app` | The label the app installs under, `[A-Za-z0-9_-]{1,64}`. A node holds one app per label, and the label is also its storage and signing scope. A bundle under a label already installed upgrades or replaces that app (see [Protocol interop](#protocol-interop)). |
| `api` | The version of the shell contract the app was built for. The shell refuses any other by name, so a bundle from before a contract change is never installed and left silent. |
| `name`, `version`, `description` | What the app's row in the shell says. The name is the label unless given. |
| `protocols` | The protocol ids the app claims. A peer's frame under one of them reaches its guest, and they are the only ids its guest may send under. The builder tells the guest them too, as `APP.protocols`, since a guest is handed its config and not its manifest's claims. Left out, the one id the label spells, which is what chat and jam claim. |
| `requires` | Everything its guest reaches: `_net` (the network), `fs` (a keyspace of its own), `timer` (one wake). The shell grants nothing else, and the consent row shows the list. Left out, `_net`. |
| `guest` | The guest's source files, joined in order behind seedkernel's op-frame. A library two apps share is one more path. Left out, the guest is the room pipe: the three files in `assembly/guest-lib/`, which are a guest by themselves. |
| `ui` | The view, an HTML page, with any stylesheets and scripts it names. Left out for an app with nothing to show. |
| `modules` | Pure WASM modules, by the name the guest calls each: a built `.wasm`, or an AssemblyScript entry (`.ts`), which the builder compiles. May be left out. |

`npm run build:apps` signs it, with every other app. The name, version,
description and view go into the signed manifest (`guest.config.shell`), so they are
vouched for by the same key as the code.

## 2. The guest: the app's behaviour

Confined JS with one entrypoint, `handle(bytes)`, and one way out, `host.call(name,
bytes)` (seedkernel §12.2). The shell hands it three things and reads none of the
answers. Each answer goes to the view, or is nothing.

| Caller | `handle` receives | Sent | Its answer |
| --- | --- | --- | --- |
| A peer | `[sender 32][frame …]` under a protocol the app claims. The sender's key is put in front by the transport once the channel has authenticated the peer; the guest never verifies anything. | When the frame arrives. | **Render bytes**, for the view. |
| The shell, op `ctx` | `[zero 32][3]["ctx"][JSON]`: the node's context, below. | After the install, when the context changes, and when the view says it is ready. | Render bytes too. |
| The shell, op `ui` | `[zero 32][2]["ui"][bytes …]`: whatever the app's own view posted with `call`. | When the view calls. | The **answer** to that call. |

The 32-byte caller id tells a peer from the shell, and `callerOf`/`readOp` from
seedkernel's op-frame split both. `assembly/guest-lib/context.js` does that once, as the
`handle` of any guest that names it, so a guest is written as what it does with each
caller:

```js
guest.peer = (caller, frame) => …;   // a peer's frame: render bytes, or EMPTY
guest.view = async (bytes) => …;     // the view's call: its answer, or EMPTY
```

The context it keeps itself: the rooms a guest decides with (`inRoom`), and all of it
passed on to the view as render type 0. To send, a guest calls `_net` (`netSend` in
`assembly/guest-lib/net.js`); to draw, it calls its own module by name, or builds the
bytes itself.

`assembly/guest-lib/room-pipe.js` sets both, and is a guest whole. A frame on the wire is
`[room 32][body]` under the app's first protocol, and the pipe reads the room and never
the body:

| What the view asks (`ui`) | |
| --- | --- |
| `[1][frame]` cast | The frame goes to every linked member of its room. |
| `[2][to 32][frame]` tell | The frame goes to one member of its room. |

| What it renders | |
| --- | --- |
| `[0][context JSON]` | The node's context (`context.js`). |
| `[1][from 32][frame]` | A peer's frame, passed on only if the relay lists its sender in the room it names. |

An app that needs more than the pipe lists a guest file of its own behind it and sets
`guest.peer` or `guest.view` again, handing the rest to `pipePeer` and `pipeView`. Jam's
does: it hashes a block of audio on its way in, and answers one more ask.

An answer to a peer's frame is **render bytes and nothing else**. The shell hands every
one to the view (seedkernel's `onInbound`), so a guest that answered a peer's request with
the reply itself would be drawing that reply on its own page. An app that asks a peer for
something therefore has the peer send it back as a frame of its own, which is how jam moves
audio. Asking its own guest is another matter: what a guest answers the `ui` op goes back
to the call the view made, which is how jam's view learns what a block is called.

The **context** is UTF-8 JSON, with every key and room id in lowercase hex and every list
in order, so the same context is always the same bytes. A guest reads it with the op-frame
prelude's `utf8Decode`, since its realm has no `TextDecoder`:

```json
{
  "api": 3,
  "me": "<this node's key>",
  "nick": "<what this node calls itself, or empty>",
  "rooms": [{ "id": "<room id>", "name": "cats", "members": ["<key>"] }],
  "linked": ["<key>"],
  "contacts": ["<key>"],
  "nicks": { "<key>": "<what that peer calls itself>" }
}
```

It is the shell's to know and the same for every app: rooms are joined on the Network
tab, and a nick is set there. A contact's secret is never in it. A view hears it as
`app.onContext`, and `app.nameOf(key)` reads a peer's nick out of the last one.

## 3. The view: `ui.html`

An HTML page, signed and loaded as one self-contained document. It can be written as
several files: a `<link rel="stylesheet" href="ui.css">` or a `<script src="ui.js"></script>`
naming a file by its path from the page is replaced by that file's text when the bundle is
built (`readView` in `scripts/app-source.mjs`), so the page opens in a browser as it stands
and travels as one. Nothing else can be named: there is no file beside a view once it is
running. Chat's view is three files and the view library, and jam's has a second script
beside its own.

The shell loads it into an iframe sandboxed `allow-scripts allow-forms
allow-downloads` from a `blob:` URL, so it has no access to the page's keys. A view may
hand the user a file it has put together, as a link to a blob of its own, which is how
jam saves a track; it reads and writes nothing on disk.

A view reaches nothing but its guest. What an app reaches is what its guest reaches, which
is on its consent row; a view is granted nothing, and the shell holds it to that
(`browser/view-guard.js`). The page loaded is the author's with two things put in front:

- **A Content Security Policy of its own**, `default-src 'none'` and little given back.
  No request leaves a view: no `fetch`, no WebSocket, no image, stylesheet or font from
  anywhere, no form sent, no script that names a file. What it shows is its own inline
  styles, images and media it holds as `data:` or `blob:`, and fonts as `data:`. It may
  run WASM, and a worker made from a blob.
- **A prelude**, the one script the policy lets the parser run. It takes
  `RTCPeerConnection` out of the page, since a peer connection asks whatever server its
  script names and no policy governs that, and then runs the view's own scripts, where
  they stood and in order.

So a view is written with these in mind:

- Its scripts run as the page is parsed, as written, but they are run by the prelude and
  not the parser. An **inline handler** (`onclick="…"`) and a `javascript:` URL are the
  parser's and do not run: listen with `addEventListener`. A script the view makes itself
  (`document.createElement("script")`) runs if it carries its code; one that names a file
  loads nothing, and nor does `import()` or a worker's `importScripts`.
- There is **no WebRTC** in a view, and no frame it makes gets one: a frame inherits the
  policy, so nothing runs in it but the same prelude.
- Nothing outside the bundle can be loaded, a font or a script from a CDN included. What
  a view needs travels in it.

One thing is left that no policy stops: a `<link rel="preconnect">` or `dns-prefetch` opens
a connection to, or looks up, a name of the view's choosing. Nothing is sent on it but the
name, and the name is the view's to choose: so a view can tell a server it names a little
at a time, and hears nothing back.

The same opaque
origin is refused the camera and microphone, which is why a call is the shell's. Nor will a
media element there load a `blob:` URL: in Chromium an `<audio>` given one stalls without
an error, so a view that plays audio decodes it with Web Audio, as jam's does. Each
installed app has its own, kept until the app is removed or replaced. It talks to the
shell only via `postMessage`:

| Direction | Message | Meaning |
| --- | --- | --- |
| view → shell | `{ type: "ready" }` | Sent once on load. The shell tells the guest the context, hands the view that answer, then flushes any renders queued while it loaded. |
| view → shell | `{ type: "call", id: integer, bytes: Uint8Array }` | Bytes for the app's own guest (its `ui` op). The shell does not read them. `id` is the view's to choose, and comes back on the answer. |
| shell → view | `{ type: "answer", id, payload: Uint8Array }` | What the guest answered that call, which may be nothing. Every call is answered: one whose guest failed gets `{ type: "answer", id, error: string }` instead. |
| shell → view | `{ type: "render", payload: Uint8Array }` | Render bytes the app's guest answered: to a peer's frame, or to the context. The format is the app's. |
| view → shell | `{ type: "conv", room?: hex, to?: hex }` | The conversation now open, a room or one peer, or neither for none. A call started from the shell is with it; an app that never says calls every linked peer. |
| view → shell | `{ type: "contact", peer: hex }` | Make a peer a contact, so the link to it outlives any shared room. Only of a peer the node shares a room with or is linked to, which are the ones a view is told of: a key from anywhere else is refused, and is the user's to add on the Network tab. |

So a view learns of rooms, peers and nicks from its own guest, as a render, and the two
never hold different pictures.

A view need not write any of that. `assembly/view-lib/app.js`, named in a script tag ahead
of the view's own (`<script src="../view-lib/app.js"></script>`), is the same door as one
object, with `toHex`, `fromHex` and `concat` beside it:

| | |
| --- | --- |
| `app.ready()` | The view is listening. |
| `app.call(...parts)` | The parts, end to end, for the guest. A promise of its answer, rejected if the guest failed. |
| `app.onRender(fn)` | `fn(bytes)` for each render. |
| `app.onContext(fn)` | `fn(ctx)` for the context, which is taken out of what `onRender` hears. |
| `app.conv({ room })`, `app.conv({ to })`, `app.conv()` | The conversation now open. |
| `app.contact(peer)` | Make a peer a contact. |
| `app.cast(room, ...parts)` | With the room pipe: a frame to every linked member of a room. |
| `app.tell(room, to, ...parts)` | With the room pipe: a frame to one member of it. |
| `app.onFrame(fn)` | With the room pipe: `fn(from, room, body)` for a peer's frame, taken out of what `onRender` hears. |

Rooms and peers are named by id in hex, as the context names them.

## 4. Modules: pure compute, optional

A pure WASM transform the guest calls by name, with no I/O and no authority. Its ABI is
seedkernel's ([BUNDLE §4](https://github.com/arj03/seedkernel/blob/main/docs/BUNDLE.md#4-the-wasm-module-abi)); chat's module
asks for a larger scratch region than the default, for images.

## Building it

`npm run build` signs every app under `assembly/`, and `npm run build:apps` does that
alone, without the vendored runtime. One app is signed by naming its
directory:

```sh
npm run build:apps -- assembly/my-app      # → bundle/<its label>.skb
```

A module named by its AssemblyScript entry is compiled on the way, in memory, so there is
no compiler config to write and no step to run first. There is no in-browser signing: anyone
installing a custom app builds their own `.skb`. Admission trust is purely "did I
consent to install this bundle", never "did I sign it as myself".

## Chat, the reference app

Text and images, written to a room or to one peer. All of it is in `assembly/chat-app/`.

**A frame** is `[type u8][body …]`, the same bytes on the wire, from the view to the
guest, and into the module. The shell never reads one.

| `type` | Body |
| --- | --- |
| `0x03` / `0x04` direct text / image | `[to 32][content]` |
| `0x05` / `0x06` room text / image | `[room 32][content]`, `room` the room's id on the relay |

A message is written to a room or to one peer, never to everyone linked. A node can be in
several rooms at once, so a room message names its room.

**The guest** (`chat-app/guest.js`) does three things with a frame. Its own, from
the view, it sends to the linked members of the frame's room, or to the one peer a direct
frame names. A peer's it draws only if it is for this node: a room frame from someone the
relay lists in that room, or a direct one addressed to this node. A frame of a type it
does not speak is not drawn. And either way it has the module draw the frame, and answers
what was drawn: a peer's frame as a render, and the view's own as the answer to the call
that sent it, which is the local echo.

**What the view draws** is one of:

```
[0][context JSON]                       the node's context, passed on for the view
[type u8][pkLen u8][pk …][body …]       a frame as the module drew it
```

A sender's nick is not in a frame or a render. It is the shell's, and the view reads it
out of the context.

## Protocol interop

A frame carries a *protocol id*, not an app name. An app's signed manifest claims
its ids (`protocols` in its `app.json`; every chat app claims the one id `chat`), and
installing an app is what routes them, so two peers running different authors'
chat apps, or different versions of one, interoperate as long as both speak the
protocol, and neither had to point anything at anything. A claim has one holder, so a
node runs one chat app at a time, beside any apps that claim other ids. A second one
under the same `app` label **replaces** the first: accept a peer's Offer and their app
becomes the one this node chats with. The author's own next version upgrades in one
click; a different author's app asks first, because it takes over the label's data and
signing scope along with the slot (seedkernel §12.4). One under a different label is
refused while the first holds `chat`: remove the first to install it.

## Troubleshooting

- **An app's message never leaves, and Diagnostics says it `does not claim` a protocol.**
  An app sends only under the protocols in its own `protocols`. Add the one it sends under
  there, which also makes it the app that receives it on this node.
- **A button in a view does nothing, or a font or image is missing.** An inline handler
  (`onclick="…"`) does not run, so listen with `addEventListener`; and nothing loads from
  outside the bundle, so a view carries what it shows ([The view](#3-the-view-uihtml)).
