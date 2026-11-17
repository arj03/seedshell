# seedshell: an app shell, and its apps, for [seedkernel](https://github.com/arj03/seedkernel)

seedshell is a browser page that hosts seedkernel apps. The **shell** owns what is the
same for every app: this node's identity and nick, the relay, rooms, peers and contacts,
installing and offering apps, and calls. It knows nothing about what any app does.

An **app** is a signed bundle (`.skb`) that carries everything of its own: a confined JS
**guest** that is its behaviour, an HTML **view** the shell runs in a sandboxed iframe,
and any pure WASM modules the guest drives. The shell passes bytes between a view and its
guest and reads none of them, so a new version of an app is a new bundle, and the shell
does not change. The apps here:

| App | What it is |
| --- | --- |
| **Chat** | Text and images, in rooms and in direct chats. |
| **Jam** | A room's chat with emoji reactions, and a playlist the room keeps and plays together: FLAC and Ogg Vorbis files streamed from peer to peer as they are. |
| **Hello** | The least an app can be, an `app.json` and a page, and the one to copy. |
| **Radio** | A jam room member with no page, run from a console with a directory of music behind it. |

Peers meet on a [seedrelay](https://github.com/arj03/seedrelay) and move to WebRTC when
they can. The shell lives outside the seedkernel repo because an app is a consumer of the
runtime, not part of it: it reaches seedkernel only through the published entry points of
`seedkernel-wasm` (seedkernel's
[CLIENT](https://github.com/arj03/seedkernel/blob/main/docs/CLIENT.md) guide).

More in [docs/](docs/): [APPS](docs/APPS.md) (writing an app, and chat's wire),
[JAM](docs/JAM.md) (jam and the radio) and [ARCHITECTURE](docs/ARCHITECTURE.md) (trust
model, files, and the seedkernel surface).

## Quick start

It needs Node ≥ 22 and checkouts of seedkernel and seedrelay beside this one, which it
uses as `file:` dependencies (`../seedkernel/WASM`, `../seedrelay`).

```sh
cd ../seedkernel/WASM && npm install && npm run build
cd ../../seedshell && npm install && npm run build
npm run relay        # the relay; prints its URL
npm run serve        # in another terminal: http://localhost:3000/shell.html
```

Open the page in two tabs, join the same room on the **Network** tab in both, and drop
`bundle/chat.skb` (or `jam.skb`, or `hello.skb`) on the **Apps** tab of each.

| Script | What it does |
| --- | --- |
| `npm run build` | Signs every app under `assembly/` into `bundle/<app>.skb`, and the shell's boot bundle, then vendors the runtime. |
| `npm run build:apps` | Signs the apps only. `npm run build:apps -- assembly/jam-app` signs just one. |
| `npm run vendor` | Copies the built seedkernel host, its host blob and seedrelay's room client into `browser/vendor/`. |
| `npm run relay` | Starts a seedrelay on port 8080, with STUN on UDP 3478 and 3479. |
| `npm run serve` | Re-vendors, then serves `browser/` on port 3000 with caching off. |
| `npm run radio -- <dir>` | Starts a [radio](#the-radio) on a directory of music. |
| `npm run smoke` | Headless test: two shells, the real apps, an upgrade in place, offers and call signals. Run it after every seedkernel update. |
| `npm run e2e` | The page in a real headless Chrome, Edge or Chromium, two tabs and a relay. Run it after a change to the shell or an app's view. |
| `npm run clean` | Deletes `browser/vendor/`. |

The first build mints the author key `chat-author.key`, and a `<app>-author.version` file
per app. **Back them up together.** Bundles signed under a new key are a different author,
so peers can no longer upgrade in one click from your earlier ones, and a lost version
file restarts the count at 1.

## Using the shell

**Identity and nick.** Each tab mints an Ed25519 identity and keeps it in
`sessionStorage`, so two tabs are two peers and closing a tab discards its identity. *My
nick* on the **Network** tab is what the node calls itself to its peers and their apps. It
is a peer's own word: the key is what the channel authenticated.

**Apps.** Drop a `.skb` on the **Apps** tab to install it, or a newer one of an installed
app to upgrade it. The row is the permission prompt: who wrote the app, the protocols it
**serves** and what it **reaches** (the network, a keyspace of its own, a timer), read off
its signed manifest. A bundle reaching for anything else is refused. **Open** puts an app's
view in front. A node holds six apps beside the shell's own two bundles. What an app
stores lasts until the tab is reloaded.

**Offers.** Peers hand each other bundles. An offer shows the same row, is verified
against its author's signature, and installs on one click. It waits only as long as the
page.

**Rooms.** **Connect** puts the node on the relay in the URL field; **Join** joins a room
(`global` if none is typed), connecting first if needed. Anyone with a room's name can
join it, so **Random** gives a name an ending nobody can guess. Each room has a **Copy
link** (`…/shell.html#room=<name>`) and a **Leave**. The relay sees a hash of each name,
never the name.

**Contacts.** A contact is a peer you link to by key, room or not: **Add peer** beside a
room-mate, or under the Peers list with a contact link. **Remove peer** undoes it at both
ends. The node's **contact secret** gates who may call it: a caller who shares no room
with you must present it, and a wrong one is refused silently. **Copy contact link** gives
`…#pk=<key>&s=<secret>`. Emptying the field makes the node public. Links carry what they
share in the URL fragment, which browsers never send.

**Relay secrets.** A relay takes only nodes that hold its secret, which the URL it prints
carries: `ws://<relay key>.<secret>@host:port`. Paste the whole URL, or put the secret in
**Relay secret**. Get it from whoever runs the relay. The relay forwards only ciphertext.

**Calls.** The call bar on the **App** tab is the shell's: **Start call** rings the
conversation open in the app (a room's linked members, or one peer), and the bar names
who that is. A peer receives nothing until it presses **Accept call**. **Mute** and **Stop
video** work separately. The page holds the media, since a sandboxed view cannot be
granted a camera or microphone.

**Direct or relayed.** The Peers list shows each peer as `direct` once its link moved to
WebRTC, or `via relay`. The peer pill in the top bar turns green once every link is
direct.

**Other devices.** `localhost` is a secure context, so plain HTTP is enough on one
machine. Another device needs the page over HTTPS and a relay it can reach (`wss://`).

## Trust model

**An app is trusted code, as a browser extension is.** Installing it is the decision. The
shell keeps the consent row true: an app cannot reach the node's signing key or the
sockets, its view can make no request of its own, and it sends only under the protocols it
claims. It does not contain an app that misuses what it was granted, so install apps from
authors you trust. **Peers are strangers**: what one sends is attributed to its
authenticated key and nothing more. The full model is in
[ARCHITECTURE](docs/ARCHITECTURE.md#trust-model).

## Writing an app

Copy `assembly/hello-app/`, give the copy its own label in `app.json`, and run
`npm run build`:

```json
{ "app": "hello", "api": 3, "ui": "ui.html" }
```

Every directory under `assembly/` with an `app.json` is signed into `bundle/<app>.skb`.
Hello names no guest, so it gets the room pipe, and its view talks to the room through
one object, `app`: `onContext`, `cast`, `onFrame`, `ready()`. Chat is the reference for an
app with a guest and a module of its own. [APPS](docs/APPS.md) has the whole contract.

## The radio

A jam room member with no page, with a directory of FLAC and Ogg Vorbis files for the
room to play from. A room it is in keeps its chat and list after the last tab closes.

```sh
npm run radio -- ~/Music --relay ws://<relay key>.<secret>@localhost:8080
                 [--room <name>] [--relay-secret <secret>] [--nick <name>] [--key <file>]
```

The room is `global` unless named. Its key is kept in `radio.key`, so it is the same peer
next time. Node has no WebRTC, so its links stay on the relay. How it works is in
[JAM](docs/JAM.md#the-radio).

## Troubleshooting

- **The shell fails in ways that look like seedkernel bugs after a rebuild.** A stale
  cache. Hard-reload; `npm run serve` turns caching off. If a rebuild still doesn't take,
  `npm run clean && npm run build`.
- **`npm run vendor` refuses with a staleness error.** Rerun `npm run build` in
  `../seedkernel/WASM`.
- **`seedkernel-wasm not found`.** The sibling checkouts are missing or misnamed.
- **`npm run smoke` can't find the boot bundle.** Run `npm run build` first.
- **`npm run e2e` finds no browser.** Set `E2E_BROWSER` to the path of Chrome, Edge or
  Chromium.
- **Peers never appear.** Both tabs need the same relay URL and the same room.
- **The relay reads as unreachable, but it is running.** It is private: enter its secret
  in **Relay secret**.
- **A contact shows `no answer`.** It is offline, on another relay, or wants a contact
  secret this node didn't present. Enter its secret on its row and **Connect**.
- **A dropped `.skb` is refused, or an offer never shows.** The notice says why, and the
  App tab's **Diagnostics** for an offer: it failed verification, or it is not an app this
  shell runs (no `shell` entry, another contract version, or it reaches something no app
  is granted).
- **`this node already holds its 8 app slots`.** Remove an app to install another.
- **A button in a view does nothing, or a font or image is missing.** Views run with no
  network and no inline handlers; see [The view](docs/APPS.md#3-the-view-uihtml).
- **Jam shows what is playing, with no sound.** Press **Tune in**.
- **A track in jam says `nobody here has it`.** Whoever held its audio has left. Remove it
  and add the file again, or start a radio with the file in its directory.
