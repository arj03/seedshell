// Shared guest source for guests whose frames are addressed to rooms: tracks the rooms and
// linked peers from the context, forwards the context to the view, and provides the
// entrypoint, which dispatches to `guest.peer` and `guest.view`. Listed after net.js in an
// app.json's `guest`.

const EMPTY = new Uint8Array(0);

/** The shell's two ops into a guest (browser/app-api.js). */
const OP_CONTEXT = "ctx";
const OP_UI = "ui";

/** Joined rooms (room id hex → Set of member keys) and linked peers, from the last context. */
let rooms = new Map();
let linked = [];

/** The `ctx` op: keep the rooms and linked peers, and pass the whole context on to the view
 *  as render type 0, `[0][json]`, so guest and view always see the same context. (A realm has
 *  no TextDecoder, hence the prelude's `utf8Decode`.) */
function setContext(json) {
  const ctx = JSON.parse(utf8Decode(json));
  rooms = new Map(ctx.rooms.map((r) => [r.id, new Set(r.members)]));
  linked = ctx.linked;
  const out = new Uint8Array(1 + json.length);
  out.set(json, 1);
  return out;
}

/** Whether `peer` is a member of the joined room `room` (being linked is not enough). */
function inRoom(room, peer) {
  const members = rooms.get(room);
  return members !== undefined && members.has(peer);
}

/** The linked members of the joined room `room`, as key hex. */
function linkedIn(room) {
  return linked.filter((p) => inRoom(room, p));
}

/** The guest's handlers. Each returns bytes, or `EMPTY` for nothing:
 *
 *    guest.peer(caller, frame)   a peer's frame under a claimed protocol; `caller` is the
 *                                authenticated 32-byte key. The answer is render bytes for
 *                                the view (delivered via the page's onInbound, §12.10).
 *    guest.view(bytes)           a `call` from the app's view. The answer is the call's reply.
 *
 *  Later files in an app's `guest` list can override or wrap these, as jam's does with
 *  room-pipe.js's. */
const guest = { peer: () => EMPTY, view: () => EMPTY };

/** The guest entrypoint (§12.2): dispatches a peer's frame or one of the shell's ops. */
async function handle(arg) {
  const { fromHost, caller, body } = callerOf(arg);
  if (!fromHost) return await guest.peer(caller, body);
  const { op, args } = readOp(body);
  if (op === OP_CONTEXT) return setContext(args);
  return op === OP_UI ? await guest.view(args) : EMPTY;
}
