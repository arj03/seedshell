// Who a shell is linked to, and why: the relay it is on, the rooms it is in and who the relay
// says is in each, its contacts, and what each peer calls itself. The page (shell.js) and
// the shell with no page (node/shell.mjs) follow their peers through this one class, and
// draw, keep and tell what they each do with it around it. Nothing here touches a page.
//
// Links are the TRANSPORT GUEST's own. What a shell tells it, a relay to register on or a
// peer's address, goes through `shell.call`, the host's door into a co-resident guest's
// `services` claim (seedkernel §12.10), composed with seedkernel's own `OpArgs`, so the
// argument writer and the transport's reader move in one artifact. What it tells a shell
// comes the other way, as `onStatus` (`status` here): the relay's state, and who is linked
// and how each is reached.
//
// Rooms are a shell's, not the transport's: it meets peers in a relay room with seedrelay's
// room client and hands their keys to the transport, which knows only keys and the relays
// that reach them. Two ways to be linked to a peer, and one gate:
//
//   A ROOM has no secret. Joining one is agreeing to be linked to everyone in it, and a
//   shell may be in several at once. The transport is told who the room-mates are
//   (`welcome`), and answers their calls whether or not they hold the contact secret.
//
//   A CONTACT is one peer, by key, linked whatever room either is in: a direct connection.
//   Calling a contact takes its contact secret, if it has one.
//
//   The CONTACT SECRET is a node's own (seedkernel §12.6.3): 32 bytes a caller must present
//   to be answered at all, unless it is a room-mate. None, and anyone may call.

import { OpArgs } from "seedkernel-wasm/op-frame";
import { roomClient, roomId } from "seedrelay/rooms";
import { NET_PROTO, contextJson, toHex, fromHex } from "./app-api.js";

/** The longest nick kept, a peer's or this node's. */
export const MAX_NICK = 32;

/** Room names stay URL-safe identifier characters, length 1..128, so they read cleanly in
 *  the relay URL and room links; the relay itself sees only a hash of the name. */
export const ROOM_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** A room's name as people say it: without the random suffix "Random" gives one. */
export const friendlyRoom = (name) => name.replace(/-[0-9a-f]{32}$/, "") || name;

/** How long a dial waits for its peer to link before it is told there was no answer. The
 *  transport answers sooner for a peer that cannot be reached, and settles within the
 *  realm's own deadline whatever is asked (seedkernel §12.3). */
const DIAL_MS = 10_000;

const EMPTY = new Uint8Array(0);

export class Peers {
  /**
   * `shell` is the node's, `identity` its keypair and `sodium` the crypto that signs a room
   * client's word with it. `tell(key, bytes)` tells a peer's shell something under shell/v1,
   * and answers whether it got it (the shell boot bundle's `tell`). `changed` is called each
   * time what a shell shows of its peers may have changed; `onRooms(renamed)` when who is in
   * its rooms has, `renamed` when which rooms they are has too; and `onRefused(name)` for a
   * room the relay turned it away from, which is left.
   */
  constructor({ shell, identity, sodium, tell, changed = () => {}, onRooms = () => {}, onRefused = () => {} }) {
    Object.assign(this, { shell, identity, sodium, tell, changed, onRooms, onRefused });
    this.me = toHex(identity.publicKey);
    /** What this node calls itself, or "" for none. */
    this.nick = "";
    /** The rooms this shell is in, by name: `id` is the room's id on the relay, in hex, and
     *  `members` the keys the room client last heard are in it. */
    this.rooms = new Map();
    /** The contacts, by key in hex, each with its contact secret or null. */
    this.contacts = new Map();
    /** Everyone this shell wants a link to, by key in hex: its room-mates and its contacts,
     *  each with how the call to it stands (`dial`). */
    this.wanted = new Map();
    /** What each peer calls itself, by key in hex: a peer's own word for itself. */
    this.nicks = new Map();
    /** The relay this shell is on: its origin, its secret if it is private, and the room
     *  client there. null while it is on none. */
    this.relay = null;
    /** The relay's state as the transport last said it: 0 none, 1 registered, 2 redialing. */
    this.relayState = 0;
    /** The linked peers as the transport last told them, by key in hex, each with whether
     *  its link is direct (seedkernel §12.7). */
    this.linked = new Map();
    /** The linked peers whose shell has heard this node's nick. Only ever narrowed to who is
     *  linked, so a peer that dropped and came back, and has forgotten, is told again. */
    this.nickTold = new Set();
  }

  /** One op of the transport's, and its answer. */
  net(op) { return this.shell.call(NET_PROTO, op.build()); }

  /** One op of the transport's, when there is nothing to do about one it refuses. */
  netOp(op) { return this.net(op).catch(() => {}); }

  /** What a peer is shown as: the nick it told this shell, or the start of its key. */
  label(key) { return this.nicks.get(key) ?? key.slice(0, 8); }

  /** The joined room with this id, as [name, room], or undefined. */
  roomById(id) { return [...this.rooms].find(([, r]) => r.id === id); }

  /** The names of the joined rooms `key` is in. */
  roomsOf(key) { return [...this.rooms].filter(([, r]) => r.members.has(key)).map(([name]) => name); }

  /** Everyone in a room with this node. */
  mates() {
    const mates = new Set();
    for (const r of this.rooms.values()) for (const key of r.members) mates.add(key);
    return mates;
  }

  /** The node's context, as every app's guest is told it (`contextJson`, app-api.js). */
  context() {
    return contextJson({
      me: this.me,
      nick: this.nick,
      rooms: [...this.rooms].map(([name, r]) => ({ id: r.id, name: friendlyRoom(name), members: r.members })),
      linked: this.linked.keys(),
      contacts: this.contacts.keys(),
      nicks: this.nicks,
    });
  }

  // ── the transport ──────────────────────────────────────────────────────────

  /** What the transport says each time its relay or its links change (`onStatus`). */
  status({ relay, linked }) {
    this.relayState = relay;
    this.linked = new Map(linked.map(({ key, direct }) => [toHex(key), direct]));
    this.follow();
  }

  /** Bring the transport in step with who this shell wants linked, for `keys`, or for
   *  everyone with none named: room-mates are welcomed, so their calls need no contact
   *  secret, and each wanted peer gets its address, the rest none. */
  sync(keys) {
    const mates = this.mates();
    void this.netOp(new OpArgs("welcome").blob(fromHex([...mates].join(""))));
    const want = (key) => mates.has(key) || this.contacts.has(key);
    for (const key of keys ?? new Set([...this.wanted.keys(), ...mates, ...this.contacts.keys()])) {
      if (!want(key)) this.wanted.delete(key);
      else if (!this.wanted.has(key)) this.wanted.set(key, { silent: false, calling: false });
      this.teach(key);
    }
    this.follow();
  }

  /** Give the transport its address for `key`: the contact secret to present, none to a
   *  room-mate, which welcomes this node, and the relay to call it through. A key this shell
   *  does not want linked has no destination, and none has one while it is on no relay: the
   *  transport dials only what has one. */
  teach(key) {
    const secret = this.roomsOf(key).length > 0 ? null : this.contacts.get(key);
    void this.netOp(new OpArgs("addr").blob(fromHex(key)).blob(secret ?? EMPTY)
      .text(this.relay && this.wanted.has(key) ? `relay+${this.relay.origin}` : ""));
  }

  /** Run when the links or the relay's state change, and when who this shell wants linked
   *  does. Nothing here runs by the clock. A wanted peer with no link is dialed, one whose
   *  link dropped as much as one that never had one, while the transport is registered on
   *  the relay the dial goes through. One that gave no answer is left alone (`dial`). Each
   *  linked peer is told this node's nick, once. */
  follow() {
    for (const [key, w] of this.wanted) {
      if (this.linked.has(key)) w.silent = false;
      else if (this.relay && this.relayState === 1 && !w.silent && !w.calling) void this.dial(key, w);
    }
    this.tellNick();
    this.changed();
  }

  /** Dial `key`, a wanted peer this node has no link to. Two that dial each other end up on
   *  one link, since the transport keeps the smaller key's of a double connect (seedkernel
   *  §12.6). One that does not link reads as `silent`, and is left alone until it is called
   *  afresh, calls this node, or joins a room again: one not on the relay is known at once,
   *  and one that ignores the call, as a node whose contact secret was not presented does,
   *  once the handshake gives up on it. */
  async dial(key, w) {
    w.calling = true;
    const answer = await this.net(new OpArgs("dial").blob(fromHex(key)).u32(DIAL_MS)).catch(() => null);
    w.calling = false;
    if (answer?.[0] === 1 || this.linked.has(key)) return;
    w.silent = true;
    this.changed();
  }

  /** Have `key` called afresh, as a contact given again is. A dial to it still under way
   *  presents what was known of it before, so the transport drops it with the peer's
   *  address, and the next sync gives the peer one and dials it. Not for a linked peer,
   *  whose link a forget would close. */
  callAfresh(key) {
    if (!this.linked.has(key)) void this.netOp(new OpArgs("forget").blob(fromHex(key)));
    this.wanted.delete(key);
  }

  /** Close the links to those of `before` this shell no longer wants. Only what the user did
   *  hangs up, leaving a room or removing a contact: a peer merely heard leaving hangs up
   *  itself, and one whose relay dropped has not gone anywhere. */
  hangUpUnwanted(before) {
    for (const key of before) {
      if (!this.wanted.has(key)) void this.netOp(new OpArgs("forget").blob(fromHex(key)));
    }
  }

  /** The ICE servers the transport uses toward `key` (seedkernel `ice`), for a peer
   *  connection of the shell's own to ask the same STUN. */
  async ice(key) {
    try { return JSON.parse(new TextDecoder().decode(await this.net(new OpArgs("ice").blob(fromHex(key))))); }
    catch { return []; }
  }

  // ── nicks ──────────────────────────────────────────────────────────────────

  /** Set this node's nick, or with "" have none. Every peer's copy is stale, so nobody
   *  counts as told any more. */
  setNick(nick) {
    this.nick = nick.trim().slice(0, MAX_NICK);
    this.nickTold.clear();
    this.tellNick();
  }

  /** What a peer said it calls itself, an empty nick for nothing. */
  heardNick(key, nick) {
    if (nick) this.nicks.set(key, nick.slice(0, MAX_NICK)); else this.nicks.delete(key);
  }

  /** Give each linked peer that has not heard it this node's nick. A peer counts as told
   *  before the send, so nothing tells it twice, and no longer if its shell did not get it. */
  tellNick() {
    for (const key of [...this.nickTold]) if (!this.linked.has(key)) this.nickTold.delete(key);
    const notice = new TextEncoder().encode(JSON.stringify({ nick: this.nick }));
    for (const key of this.linked.keys()) {
      if (this.nickTold.has(key)) continue;
      this.nickTold.add(key);
      void this.tell(key, notice).catch(() => false).then((told) => { if (!told) this.nickTold.delete(key); });
    }
  }

  // ── the relay and its rooms ────────────────────────────────────────────────

  /** Be on the relay at `origin`, with `relaySecret` for a private one: the room client in
   *  every joined room, and the transport registered there, so this node's key can be called.
   *  Over once the transport is registered, or once that attempt has failed. */
  async joinRelay(origin, relaySecret = null) {
    const fresh = this.relay?.origin !== origin || this.relay.relaySecret !== relaySecret;
    if (fresh) {
      // The old relay's rooms are left, and their members heard leaving.
      this.relay?.client.close();
      const { sodium, identity } = this;
      const client = roomClient({
        relay: origin,
        publicKey: identity.publicKey,
        sign: (m) => sodium.crypto_sign_detached(m, identity.privateKey),
        ...(relaySecret ? { secret: relaySecret, blake2b: (m) => sodium.crypto_generichash(64, m) } : {}),
        onMember: (room, key, present) => this.onMember(room, key, present),
        onRefused: (name) => {
          this.rooms.delete(name);
          this.onRefused(name);
          this.roomsChanged();
        },
      });
      this.relay = { origin, relaySecret, client };
      // Contacts are called through this relay now: each is given its address there before
      // the transport says it is registered, which is when they are called (`follow`).
      this.sync();
    }
    const { client } = this.relay;
    const op = new OpArgs("relay").text(origin);
    if (relaySecret) op.text(relaySecret);
    await this.net(op);
    // The rooms are joined once the transport is registered: a room tells its members of
    // this node, and one of them calls it as soon as it hears.
    if (fresh && this.relay?.client === client) {
      for (const name of this.rooms.keys()) await client.join(name);
    }
  }

  /** Be on no relay. The rooms keep their names for the next join, with nobody heard in
   *  them, so the links they were the reason for are closed; a contact already linked stays
   *  linked. */
  async leaveRelay() {
    if (!this.relay) return;
    const before = [...this.wanted.keys()];
    const { client } = this.relay;
    this.relay = null;
    // The room client hears every member leave as it closes (`onMember`), and with no relay
    // a contact has no address to be called at.
    client.close();
    this.sync();
    this.hangUpUnwanted(before);
    await this.netOp(new OpArgs("relay").text(""));
  }

  /** Join the room `name`, beside any already joined. */
  async joinRoom(name) {
    if (this.rooms.has(name)) return;
    this.rooms.set(name, { id: await roomId(name), members: new Set() });
    this.roomsChanged();
    await this.relay?.client.join(name);
  }

  /** Leave one room, and hang up on everyone it was the only reason to be linked to. */
  async leaveRoom(name) {
    if (!this.rooms.has(name)) return;
    const before = [...this.wanted.keys()];
    await this.relay?.client.leave(name);
    this.rooms.delete(name);
    this.roomsChanged();
    this.hangUpUnwanted(before);
  }

  /** The joined rooms changed: whoever was in them is wanted or not afresh. */
  roomsChanged() {
    this.onRooms(true);
    this.sync();
  }

  /** A key the room client heard join or leave a room. One that joins is called afresh. */
  onMember(room, key, present) {
    const r = this.rooms.get(room);
    if (!r || key === this.me) return;
    if (present) { r.members.add(key); this.wanted.delete(key); }
    else r.members.delete(key);
    this.onRooms(false);
    this.sync([key]);
  }

  // ── contacts ───────────────────────────────────────────────────────────────

  /** Make `key` a contact, with its contact secret or null: linked whether or not a room is
   *  shared. */
  addContact(key, secret) {
    if (key === this.me) return;
    this.contacts.set(key, secret);
    this.sync([key]);
  }

  /** Stop `key` being a contact. */
  removeContact(key) {
    this.contacts.delete(key);
    this.sync([key]);
  }
}
