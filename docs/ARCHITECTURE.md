# seedshell: architecture

How the shell is put together: what it trusts an app with and enforces, what each file
is, and the seedkernel surface it stands on. The [README](../README.md) says how to run it.

## Trust model

**An app is trusted code, as a browser extension is.** Installing one is the decision, and
the row on the Apps tab is the permission prompt: who wrote it, the protocols it **serves**
and what it **reaches**, all read off its signed manifest. Dropping a file, or clicking
install on an Offer, says you trust that author with what the row lists. The shell does not
try to contain an app that misuses what it was granted; it keeps the row true, and it
treats peers, who are not asked, as strangers.

**What installing an app grants.** Its guest runs with the grants in `requires`:

- `_net`, the network: it sends to any peer this node is linked to, as this node, under the
  protocols it claims and no other, and receives the frames of those protocols.
- `fs`, a keyspace of its own in the one storage backend the shell runs.
- `timer`, one wake.

Its view is part of the app and is granted nothing of its own. Every app is also told the
context: this node's rooms (with the ids that join them), the linked peers, the contacts and
each peer's nick.

**What the shell enforces, so that the row is true:**

- An app cannot reach the node's signing key or the sockets, and a bundle that asks is not
  installed (`appFacts`, `browser/app-api.js`).
- A consent names the whole bundle, guest and view, so an update that changes behaviour is a
  new consent, and a bundle from a different author under an installed label asks first.
- A view reaches nothing but its own guest: no request of any kind, no WebRTC, no frame it
  can run script in (`browser/view-guard.js`). So an app that did not ask for `_net` has no
  network through its view either. The doors a view has to the shell are held to what the
  row already says: it may make a contact only of a peer the node knows, and the call bar
  says who a call would ring, since the camera and microphone go there.
- Each claim has one owner on a node, and the shell's own, `offer/v1`, `shell/v1` and
  `call/v1`, are held by the app it pinned at boot. An app sends only under the protocol ids it claims, so it
  cannot write another app's messages, or the shell's own, as you (seedkernel §12.10); an app
  that needs a second id claims it.

**What it does not defend against.** An app with `_net` can:

- claim a protocol id before the app that would use it is installed, and receive what peers
  send under it;
- fill the shared storage or the send queue, and so starve every other app, or spend what
  its CPU and memory budgets allow;
- read every room, peer and nick in the context, and hand them to any peer it is linked to;
- carry a display name that looks like another app's. The row also shows its id and the
  start of its author's key.

So install apps from authors you trust, as you would an extension, and remove one you no
longer do. Removing an app drops its claims and stops it, and its stored keys stay under
its label for whatever is installed there next. **Peers are strangers.** What a peer sends
is attributed to the key the channel authenticated and is nothing more: the receiving guest
decides what to draw, an offer is verified, bounded and installed only by a click, and a
nick is a peer's own word.

## Calls

Media rides peer connections the page owns, one per peer, beside the transport's and
asking the same STUN servers, which the transport names for each peer (its `ice` op).
Their signaling rides the node's authenticated channel,
so a call needs no relay once the peers are linked, and nobody on the relay can inject
into one.

A call is the shell's because an app cannot hold one. A view's sandbox gives it an opaque
origin, which cannot be granted the camera or microphone: `getUserMedia` fails there in
Chromium with a `SecurityError`, whatever the iframe's `allow` says. So the shell holds
the media, and a view only says which conversation is open (`conv`, under
[The view](APPS.md#3-the-view-uihtml)).

## What a relay sees

Identity is bound in-channel by the transport bundle's handshake, which
runs end to end through the relay, so a relay can see which keys meet and refuse to
forward, but can never read the traffic or impersonate a peer. WebRTC signaling rides the
peers' own authenticated link, so no relay or room member sees SDP or candidates.

## What's here

| Path | What it is |
| --- | --- |
| `browser/shell.*` | The browser shell: identity and nick, admission policy, the transport, the shell boot load and offers, the sockets the transport's WebRTC mesh runs over, the rooms, peers and contacts as it draws them, and a sandboxed iframe for each installed app. The inline import map in `shell.html` names the seedkernel surface. |
| `browser/peers.js` | Who a shell is linked to, and why, with nothing of a page in it: the relay, its rooms and who is in each, the contacts, the nicks, the node's context as apps are told it, and the transport ops that follow from them (`secrets`, `addr`, `dial`, `forget`, `ice`). The page and the headless shell both follow their peers through it. |
| `browser/host-blob.js` | Fetches the vendored host blob from its own `<script>`, ahead of `shell.js`, so the download runs while `shell.js`'s imports load. |
| `browser/app-api.js` | The contract between the shell and any app, in one place: the contract version, what an app may reach, what the shell reads off a signed manifest (`appFacts`), the digest a consent names, and the two ops the shell calls on an app's guest. The shell gates and drives every bundle through it, and the builder refuses to sign what it would refuse. |
| `browser/shell-app.js` | The shell app as the pages that load it speak to it: its three claims and the op that sends under each. `shell/v1` is what a page tells another about itself: `{ peer }`, that it added or removed the other as a peer, and `{ nick }`, what it calls itself; a `tell` answers whether the peer's page got it. `call/v1` is a call's signaling, and `offer/v1` an app one page offers another. The page tells them apart by the claim a frame arrived under. |
| `assembly/shell-app/` | The shell app's source, built like any app: an `app.json` with `"boot": true`, which the page loads at boot by its pin rather than a user installing it, and its guest, which hands what a peer sent under any of its claims to the page and puts the page's own on the wire. |
| `browser/view-guard.js` | What holds a view to its sandbox: `guardView` makes the page a view is loaded as, the author's own with a Content Security Policy in front that lets it make no request, and a prelude, the one script that policy lets the parser run, which takes WebRTC out of the realm and then runs the view's scripts. See [The view](APPS.md#3-the-view-uihtml). |
| `browser/media-rtc.js` | The call feature: `MediaCalls`, one `RTCPeerConnection` per peer that the page owns, beside the transport's, with perfect negotiation signaled over `call/v1`. A node in a call tells its peers so (`{ call }`), and a connection is opened only between two that have each said they are in the same one. Live media is the page's own; the host holds only the transport's connections. |
| `assembly/chat-app/` | Chat: text and images, in several rooms and in direct chats. `app.json` says what the bundle is, `guest.js` is its guest, which holds the chat wire vocabulary and decides who each frame is for, `index.ts` is its module, the one transform that draws a frame, and `ui.html` its view, with the view's CSS and JS in files of their own (`ui.css`, `ui.js`) beside the page. |
| `assembly/jam-app/` | Jam: a room's chat, emoji reactions, and a playlist kept and played together. Its guest is the room pipe, to which `guest.js` adds a name for each block of audio, its hash. `room.js` is a member of a room with nothing to show for it: the room's state, how two copies of it agree, and the audio served; the view (`ui.html`, `ui.css`, `ui.js`) is that with a page in front, which plays the room and looks through a library. `formats.js` finds where a FLAC or Ogg Vorbis file may be cut, and there is no module. See [JAM](JAM.md). |
| `assembly/hello-app/` | Hello: the least an app can be, and the one to copy. Its `app.json` names a label, the contract and a view, and its guest is the room pipe, which the builder gives an app that names none. The view (`ui.html`, `ui.js`) casts what is typed to the first room the node is in, and shows what the room's members cast. |
| `assembly/radio-app/` | The radio: a member of a jam room with no page and a library. `app.json` is a bundle of its own, claiming `jam`, whose guest is jam's and which has no view. `head.js` is what stands in front of that guest instead: jam's `room.js`, and a library answered from a directory. See [The radio](JAM.md#the-radio). |
| `node/shell.mjs` | The headless shell: a node with no page, hosting one app whose head is plain script it runs, behind the door a view has to its guest. It owns the identity, the nick, the relay, the rooms and the links, as the page does, and has no contacts, offers or calls. |
| `node/radio.mjs` | The radio, as it is started: the directory it is pointed at as a library of titles, a key file, and the headless shell running `bundle/radio.skb` with the radio's head. |
| `assembly/guest-lib/net.js` | Guest source any guest that reaches the network puts in front of its own: the transport's `send` op, and keys as hex. Every app and the boot bundle use it. |
| `assembly/guest-lib/context.js` | Guest source for a guest whose frames are written to rooms: the shell's two ops by name, the rooms and the linked peers read out of the node's context, the context passed on to the view as render type 0, and the entrypoint, which tells a peer's frame from the view's bytes so a guest is written as what it does with each (`guest.peer`, `guest.view`). Chat, jam, hello and the radio use it. |
| `assembly/guest-lib/room-pipe.js` | A guest, whole: a pipe scoped to a room, for an app whose state lives in its view. What the view casts goes to the room's linked members, what it tells goes to one of them, and a peer's frame is passed on only from a member of the room it names. An app that needs no more names no guest, and is given this one, as hello is. Jam builds on it. |
| `assembly/view-lib/app.js` | View source any view puts in front of its own: bytes as hex, and the door to the shell as one object, `app`. A call to the guest is a promise of its answer, and `cast`, `tell` and `onFrame` are the view's half of the room pipe. Every view here uses it. |
| `scripts/app-source.mjs` | Reads an app directory (`app.json` and what it names) into what gets signed: what an `app.json` leaves out filled in, a view's stylesheets and scripts put into its page, and a module written in AssemblyScript compiled. The builder and the smoke test share it. |
| `scripts/build-app-bundle.mjs` | The offline bundle author: signs every app directory under `assembly/`, or the ones it is named, into `bundle/<app>.skb` under `chat-author.key`, tracking a monotonic freshness mark per app label in `<app>-author.version`. A boot bundle is also written beside the page as a module (`browser/<app>-bundle.js`). |
| `scripts/author.mjs` | The author key and each app's version count, which the builder signs through: its first run mints the key. |
| `scripts/vendor.mjs` | Copies seedkernel's built host (`build-min`: `host/` + `services/`) into `browser/vendor/seedkernel/`, plus seedkernel's host blob without its script (`build/host-web.skb`: the QuickJS realm engine and the host's crypto) and seedrelay's room client (`rooms.mjs`). Refuses a stale seedkernel build. |
| `scripts/smoke.mjs` | Headless regression test: boots two shells over the transport bundle's channel seam, round-trips messages through the real chat app and the shell's two ops, replaces it in place with a later build, round-trips a page notice, a call signal and an offer through the shell app, each under its own claim, carries a frame and a block of audio through jam's guest, a cast and a tell through hello, whose guest is the room pipe and nothing else, and puts the radio's bundle where jam stood on one shell, to hear the other's jam. |
| `scripts/e2e.mjs` | Browser regression test, for what the smoke test cannot reach: the page and the apps' views. Serves `browser/`, starts the `seedrelay` dependency, and drives two tabs of a headless Chrome, Edge or Chromium over the DevTools pipe: install by drop, rooms, nicks, an offer, messages, an app replaced in place by a bundle dropped over it, a direct message, a call that reaches its peer only once accepted, with a microphone muted and a camera turned off and on again, and one turned down, removing an app, and a reload. Then hello beside chat, a line from one tab shown in the other, and removed. Then jam beside chat: a message and a reaction, a FLAC file added in one tab, downloaded in the other and streamed to it, a seek, the list moving on, a peer held to an uplink slower than its track plays, the list reordered and trimmed, a reload that gets the room and its music back from the other tab, and a tab left alone in the room. Then what a view may not do: each app's view tries a request, a socket, a peer connection and a script in a frame of its own, against a server that must hear nothing, then a script that names a file on the page's own server, and asks for a contact the node has never met. Then one tab removes the other as its peer and hangs up, and the other still hears of it. Last the radio, started on a directory the test fills: a tab finds its library, searches it, has titles put in the list and plays one, fetched from the radio, and after a reload gets the room back from the radio alone. When the radio goes, its tracks cannot be played and the room passes over them, and a radio started again on the same directory serves them again. The FLAC files it writes itself. It adds no Ogg Vorbis file, which only an encoder can make. |
| `scripts/clean.mjs` | Deletes `browser/vendor/` when a rebuild isn't taking. |

What the shell reads of an app (its name, version, description and view) rides in the
bundle's **signed manifest**, under `guest.config.shell`. That entry is **this shell's
convention, not a runtime contract**: the host hands `guest.config` to the guest and
reads none of it. Nothing is read out of a module, so an app needs none.

## Generated and local files (all gitignored)

| Path | What it is |
| --- | --- |
| `bundle/` | Signed bundles: `chat.skb`, `hello.skb`, `jam.skb`, `radio.skb`, `shell.skb`. |
| `browser/vendor/` | The vendored runtime the page loads. |
| `browser/shell-bundle.js` | The boot bundle embedded as a JS module, since the page is served from `browser/` and `bundle/` is not. |
| `chat-author.key` | The author signing key, minted on the first build. |
| `chat-author.version`, `hello-author.version`, `jam-author.version`, `radio-author.version`, `shell-author.version` | Each app label's version high-water mark. |
| `radio.key` | A radio's node key, minted the first time one is started, so it is the same peer the next time. |

**Back up `chat-author.key` and the `.version` files together.** The key *is* the
author identity: bundles signed under a new key are a different author, so peers
can no longer upgrade in one click from your earlier bundles. The version files
live beside the key rather than in `bundle/` so that wiping build output never
resets the count. If the key exists but a version file is missing, the build warns
and restarts at 1; put the last version you shipped back in the file before
publishing anything.

## Section references in the source

Comments across this repo cite seedkernel sections as bare `§N` (e.g. `§12.4`). Seedkernel
numbers them globally across its docs, and [its README](https://github.com/arj03/seedkernel/blob/main/README.md#the-rest-of-the-spec)
says which file holds each.

## The seedkernel surface the shell uses

The shell reaches seedkernel only through published entry points of `seedkernel-wasm`.
What each one is and does is seedkernel's to document, in its
[CLIENT](https://github.com/arj03/seedkernel/blob/main/docs/CLIENT.md) guide; this is what the shell uses them for:

| Import | Used for |
| --- | --- |
| `seedkernel-wasm` | `loadCrypto`, in the bundle builders, the radio and the smoke test |
| `seedkernel-wasm/platform-web` | `browserPlatform`, the page's platform over the host blob |
| `seedkernel-wasm/platform` | `platformHost`, the host the page's node is stood up by |
| `seedkernel-wasm/host-web.skb` | The host blob without its script, vendored beside the page and read by the smoke test |
| `seedkernel-wasm/shell-core` | `bootShell`, the headless shell's node |
| `seedkernel-wasm/bundle` | `verifyBundle` on a dropped or offered bundle, and `genesisHash` for the digest a consent names |
| `seedkernel-wasm/bundle-author` | Signing, in the offline builders only |
| `seedkernel-wasm/net-ws`, `net-rtc`, `socket-seam` | The page's sockets: a WebSocket to the relay and WebRTC to peers, combined as `transport.channels`. The headless shell takes `net-ws` alone |
| `seedkernel-wasm/fs-memory` | `MemoryFs`, the headless shell's store |
| `seedkernel-wasm/op-frame` | `writeOp` and `OpArgs`, for calls into an app's guest and into the transport |
| `seedkernel-wasm/transport-bundle` | `transportBundleBytes`, in the smoke and browser tests |

What the shell builds on them:

- **It drives the shipped transport by its ops**, through `Shell.call` on `_net`: `relay` to
  register, `contact` for this node's contact secret, `secrets` for its rooms' secrets, `addr`
  for each peer it links to, `dial` to call one and hear whether it linked, `forget` for
  one it drops, and `ice` for the STUN a call's own connections ask. It follows the relay and its
  links through `onStatus`. The relay is seedrelay, which the shell meets rooms on with
  seedrelay's own room client.
- **Its own claims are pinned.** `offer/v1`, `shell/v1` and `call/v1` belong to the shell
  boot bundle, which `admit` allows only from the author and app the page was built with. Every other bundle goes through the consent gate.
- **Both directions cross an app's guest.** A peer's frame reaches the page as the app
  guest's answer, read off its load's `onInbound`; the page's own frames, Offers, what it
  tells a peer's page and a call's signals leave through the app it pinned.
- **Guest source spells `_net` and the transport's `send` op by hand**
  (`assembly/guest-lib/net.js`), since a guest imports nothing. The smoke test runs them
  against the shipped transport.

The page's CSP has no `'unsafe-eval'`: the page imports the host and takes only the host
blob's engine, crypto and transport, rather than evaluating the blob's script. It allows
`'unsafe-inline'` because app views run in sandboxed `blob:` iframes that inherit the page's
policy. The sandbox keeps a view from the page, and the policy each view is loaded under
(`browser/view-guard.js`) keeps it from the network. The browser JS entry points are
declared in two places, the imports at the top of `shell.js` and `peers.js` and the import
map in `shell.html`, and nothing else in this repo reaches into `node_modules`. So a seedkernel
change that breaks the shell broke a public export, which is the point of the shell living
out here.
