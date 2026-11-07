// Who a shell is linked to, and why: the relay, the rooms and their members, contacts and
// nicks. Used by both the page (shell.js) and the headless shell (node/shell.mjs); nothing
// here touches the DOM.
//
// The transport guest owns the actual links. We send it ops through `shell.call` (§12.10),
// encoded with seedkernel's `OpArgs`, and it reports back via `onStatus` (`status` here).
//
// Rooms belong to the shell, not the transport: we meet peers with seedrelay's room client
// and hand their keys to the transport. There are two ways to be linked to a peer:
//
//   room      the room's secret, which everyone who knows its name holds. Joining means
//             agreeing to link with every member. We can be in several, and answer
//             whoever presents any of their secrets (the transport's `secrets`).
//   contact   a single peer, by key, linked regardless of rooms. Calling it requires its
//             contact secret, if it has one.
//
// The contact secret (§12.6.3) is 32 bytes that a caller who isn't a room-mate must present
// to be answered at all. With none set, anyone can call.

import { OpArgs } from "seedkernel-wasm/op-frame";
import { roomClient, roomId, roomSecret } from "seedrelay/rooms";
import { NET_PROTO, contextJson, toHex, fromHex } from "./app-api.js";

/** The most rooms whose secrets the transport answers to (seedkernel's `secrets`), and the
 *  most a relay seats one link in. */
const MAX_ROOM_SECRETS = 16;

/** Maximum nick length, ours or a peer's. */
export const MAX_NICK = 32;

/** Valid room names: URL-safe, 1–128 chars. The relay only ever sees a hash of the name. */
export const ROOM_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** A room name for display, without the random suffix the "Random" button adds. */
export const friendlyRoom = (name) => name.replace(/-[0-9a-f]{32}$/, "") || name;

/** How long a dial waits for a link before giving up. The transport may answer sooner. */
const DIAL_MS = 10_000;

const EMPTY = new Uint8Array(0);

export class Peers {
  /**
   * `shell` is the node, `identity` its keypair. `tell(key, bytes)` sends a shell/v1 notice and resolves to whether the peer's
   * shell got it. Callbacks: `changed()` whenever peer state may have changed;
   * `onRooms(renamed)` when room membership changed (`renamed` if the set of rooms did too);
   * `onRefused(name)` when the relay refused a room, which is then left.
   */
  constructor({ shell, identity, tell, changed = () => {}, onRooms = () => {}, onRefused = () => {} }) {
    Object.assign(this, { shell, identity, tell, changed, onRooms, onRefused });
    this.me = toHex(identity.publicKey);
    /** This node's nick, or "". */
    this.nick = "";
    /** Joined rooms by name: `{ id, members }`, with the relay room id in hex and the
     *  member keys the room client last reported. */
    this.rooms = new Map();
    /** Contacts: key hex → contact secret, or null. */
    this.contacts = new Map();
    /** Peers we want linked (room-mates and contacts): key hex → dial state (`dial`). */
    this.wanted = new Map();
    /** Peer nicks: key hex → nick (self-chosen, unverified). */
    this.nicks = new Map();
    /** `{ origin, relaySecret, client }` for the current relay, or null. */
    this.relay = null;
    /** Relay state from the transport: 0 none, 1 registered, 2 redialing. */
    this.relayState = 0;
    /** Linked peers from the transport: key hex → whether the link is direct WebRTC. */
    this.linked = new Map();
    /** Linked peers that have been sent our nick. Pruned to the linked set, so a peer that
     *  reconnects is told again. */
    this.nickTold = new Set();
  }

  /** Call a transport op. */
  net(op) { return this.shell.call(NET_PROTO, op.build()); }

  /** Call a transport op, ignoring failure. */
  netOp(op) { return this.net(op).catch(() => {}); }

  /** Display name: the peer's nick, or the start of its key. */
  label(key) { return this.nicks.get(key) ?? key.slice(0, 8); }

  /** The joined room with this id, as `[name, room]`, or undefined. */
  roomById(id) { return [...this.rooms].find(([, r]) => r.id === id); }

  /** Names of the joined rooms `key` is in. */
  roomsOf(key) { return [...this.rooms].filter(([, r]) => r.members.has(key)).map(([name]) => name); }

  /** Everyone in any of our rooms. */
  mates() {
    const mates = new Set();
    for (const r of this.rooms.values()) for (const key of r.members) mates.add(key);
    return mates;
  }

  /** The context JSON every app's guest is told (`contextJson`, app-api.js). */
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

  /** Handle the transport's status bytes (`onStatus`), which the room client reads too:
   *  `[0][relay u8]`, then `[key 32][direct u8]` per linked peer, or `[1]` and what the
   *  relay told this node, which is the room client's alone. */
  status(status) {
    this.relay?.client.status(status);
    if (status[0] !== 0) return;
    this.relayState = status[1];
    this.linked = new Map();
    for (let off = 2; off + 33 <= status.length; off += 33) {
      this.linked.set(toHex(status.subarray(off, off + 32)), status[off + 32] === 1);
    }
    this.follow();
  }

  /** Bring the transport in line with who we want linked, for `keys` or everyone: wanted
   *  peers get an address, and others have theirs cleared. */
  sync(keys) {
    const mates = this.mates();
    const want = (key) => mates.has(key) || this.contacts.has(key);
    for (const key of keys ?? new Set([...this.wanted.keys(), ...mates, ...this.contacts.keys()])) {
      if (!want(key)) this.wanted.delete(key);
      else if (!this.wanted.has(key)) this.wanted.set(key, { silent: false, calling: false });
      this.teach(key);
    }
    this.follow();
  }

  /** Tell the transport how to reach `key`: the secret to present (a room we share with it,
   *  else its contact secret) and the relay to dial through. Unwanted keys, or any key
   *  while we're on no relay, get an empty destination, so the transport won't dial them. */
  teach(key) {
    const [room] = this.roomsOf(key);
    const secret = room !== undefined ? this.rooms.get(room).secret : this.contacts.get(key);
    void this.netOp(new OpArgs("addr").blob(fromHex(key)).blob(secret ?? EMPTY)
      .text(this.relay && this.wanted.has(key) ? `relay+${this.relay.origin}` : ""));
  }

  /** React to a change in links, relay state or wanted peers (event-driven, no timers):
   *  dial wanted peers that aren't linked, unless they already went silent, and send our
   *  nick to newly linked peers. */
  follow() {
    for (const [key, w] of this.wanted) {
      if (this.linked.has(key)) w.silent = false;
      else if (this.relay && this.relayState === 1 && !w.silent && !w.calling) void this.dial(key, w);
    }
    this.tellNick();
    this.changed();
  }

  /** Dial an unlinked wanted peer. (If both sides dial, the transport keeps one link,
   *  §12.6.) A peer that doesn't answer, e.g. because we lack its contact secret, is marked
   *  `silent` and not redialed until it's called afresh, calls us, or rejoins a room. */
  async dial(key, w) {
    w.calling = true;
    const answer = await this.net(new OpArgs("dial").blob(fromHex(key)).u32(DIAL_MS)).catch(() => null);
    w.calling = false;
    if (answer?.[0] === 1 || this.linked.has(key)) return;
    w.silent = true;
    this.changed();
  }

  /** Reset `key` so the next sync dials it fresh (e.g. with a new contact secret). An
   *  in-flight dial would still use the old address, so the transport forgets it, unless the
   *  peer is linked, since forgetting closes the link. */
  callAfresh(key) {
    if (!this.linked.has(key)) void this.netOp(new OpArgs("forget").blob(fromHex(key)));
    this.wanted.delete(key);
  }

  /** Close links to peers in `before` that are no longer wanted. Only called after a user
   *  action (leaving a room, removing a contact); a peer that leaves hangs up itself. */
  hangUpUnwanted(before) {
    for (const key of before) {
      if (!this.wanted.has(key)) void this.netOp(new OpArgs("forget").blob(fromHex(key)));
    }
  }

  /** The ICE servers the transport uses toward `key`, so call connections use the same. */
  async ice(key) {
    try { return JSON.parse(new TextDecoder().decode(await this.net(new OpArgs("ice").blob(fromHex(key))))); }
    catch { return []; }
  }

  // ── nicks ──────────────────────────────────────────────────────────────────

  /** Set our nick ("" for none) and re-send it to every linked peer. */
  setNick(nick) {
    this.nick = nick.trim().slice(0, MAX_NICK);
    this.nickTold.clear();
    this.tellNick();
  }

  /** Record a peer's nick ("" clears it). */
  heardNick(key, nick) {
    if (nick) this.nicks.set(key, nick.slice(0, MAX_NICK)); else this.nicks.delete(key);
  }

  /** Send our nick to each linked peer that hasn't had it. Marked as told before sending, so
   *  it isn't sent twice, and unmarked if delivery fails. */
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

  /** Connect to the relay at `origin` (`ws[s]://<key>@host[:port]`, `relaySecret` in hex for
   *  a private one): register the transport, then join every room. Rooms travel on the
   *  transport's own relay link (`tell`). Resolves once registration succeeds or fails. */
  async joinRelay(origin, relaySecret = null) {
    const fresh = this.relay?.origin !== origin || this.relay.relaySecret !== relaySecret;
    if (fresh) {
      // Closing the old client reports its rooms' members as leaving.
      this.relay?.client.close();
      const client = roomClient({
        tell: async (bytes) => (await this.net(new OpArgs("tell").blob(bytes)))[0] === 1,
        onMember: (room, key, present) => this.onMember(room, key, present),
        onRefused: (name) => {
          this.rooms.delete(name);
          this.onRefused(name);
          this.roomsChanged();
        },
      });
      this.relay = { origin, relaySecret, client };
      // Give contacts their address on this relay now; they're dialed once it registers.
      this.sync();
    }
    const { client } = this.relay;
    const op = new OpArgs("relay").text(origin);
    if (relaySecret) op.text(relaySecret);
    await this.net(op);
    // Join rooms only after registering, since members will dial us as soon as we appear.
    if (fresh && this.relay?.client === client) {
      for (const name of this.rooms.keys()) await client.join(name);
    }
  }

  /** Leave the relay. Rooms are kept (empty) for the next connect, so links that only
   *  existed for a room close; linked contacts stay linked. */
  async leaveRelay() {
    if (!this.relay) return;
    const before = [...this.wanted.keys()];
    const { client } = this.relay;
    this.relay = null;
    // Closing reports every member as leaving (`onMember`); `sync` then clears addresses.
    client.close();
    this.sync();
    this.hangUpUnwanted(before);
    await this.netOp(new OpArgs("relay").text(""));
  }

  /** Hold a seat for room `name`, with its id and secret, and no members yet: false when it
   *  is already held. Nothing is told; `joinRoom` is the whole join. */
  async seatRoom(name) {
    if (this.rooms.has(name)) return false;
    const [id, secret] = await Promise.all([roomId(name), roomSecret(name)]);
    if (this.rooms.has(name)) return false;
    this.rooms.set(name, { id, secret, members: new Set() });
    return true;
  }

  /** Join room `name`, in addition to any others. */
  async joinRoom(name) {
    if (!(await this.seatRoom(name))) return;
    this.roomsChanged();
    await this.relay?.client.join(name);
  }

  /** Leave a room and hang up on peers we were only linked to because of it. */
  async leaveRoom(name) {
    if (!this.rooms.has(name)) return;
    const before = [...this.wanted.keys()];
    await this.relay?.client.leave(name);
    this.rooms.delete(name);
    this.roomsChanged();
    this.hangUpUnwanted(before);
  }

  /** The set of joined rooms changed: answer whoever holds one of their secrets, and
   *  recompute who is wanted. A relay seats a link in at most MAX_ROOM_SECRETS rooms, which
   *  is also as many as the transport takes. */
  roomsChanged() {
    const secrets = [...this.rooms.values()].slice(0, MAX_ROOM_SECRETS).map((r) => toHex(r.secret));
    void this.netOp(new OpArgs("secrets").blob(fromHex(secrets.join(""))));
    this.onRooms(true);
    this.sync();
  }

  /** The room client saw `key` join or leave `room`. A joiner is dialed afresh. */
  onMember(room, key, present) {
    const r = this.rooms.get(room);
    if (!r || key === this.me) return;
    if (present) { r.members.add(key); this.wanted.delete(key); }
    else r.members.delete(key);
    this.onRooms(false);
    this.sync([key]);
  }

  // ── contacts ───────────────────────────────────────────────────────────────

  /** Make `key` a contact (secret or null), so it stays linked regardless of rooms. */
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
