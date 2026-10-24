// A complete guest for apps whose state lives in the view: a pipe scoped to rooms. The guest
// decides what the view can't be trusted to: who a frame goes to, and whether an incoming
// frame comes from a member of the room it names. An app that names no guest gets this one
// (after net.js and context.js). The view side is assembly/view-lib/app.js.
//
// Apps needing more can list their own guest after this file and wrap `pipePeer` /
// `pipeView`, as jam does.

/** The protocol pipe frames use: the app's first claimed protocol. */
const PIPE_PROTO = APP.protocols[0];

/** A wire frame is `[room 32][body]`. The pipe reads only the room; the body is the view's.
 *
 *  A view's call is `[ask u8][…]`: */
const ASK_CAST = 1;      // [frame]          to every linked member of the frame's room
const ASK_TELL = 2;      // [to 32][frame]   to one member of the frame's room

/** Renders for the view. Type 0 is the context (context.js). */
const RENDER_FRAME = 1;  // [from 32][frame]   a peer's frame

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A frame's room id, in hex. */
function roomOf(frame) {
  return toHex(frame.subarray(0, 32));
}

/** Whether a frame's sender is a member of the room it names. Checked on receipt, whatever
 *  the sender's guest did. */
function fromMember(caller, frame) {
  return frame.length >= 32 && inRoom(roomOf(frame), toHex(caller));
}

/** Pass a member's frame to the view as `[1][from 32][frame]`; drop anyone else's. */
function pipePeer(caller, frame) {
  return fromMember(caller, frame) ? concat([[RENDER_FRAME], caller, frame]) : EMPTY;
}

/** A call from the view: cast to every linked member of the frame's room, or tell one
 *  member. Fire-and-forget; send failures to individual peers are ignored. */
async function pipeView(ask) {
  const rest = ask.subarray(1);
  if (ask[0] === ASK_CAST && rest.length >= 32) {
    await Promise.all(linkedIn(roomOf(rest)).map((p) => netSend(fromHex(p), PIPE_PROTO, rest).catch(() => {})));
  }
  if (ask[0] === ASK_TELL && rest.length >= 64) {
    const to = rest.subarray(0, 32), frame = rest.subarray(32);
    if (inRoom(roomOf(frame), toHex(to))) await netSend(to, PIPE_PROTO, frame).catch(() => {});
  }
  return EMPTY;
}

guest.peer = pipePeer;
guest.view = pipeView;
