// Shared view source: hex helpers and `app`, the view's interface to the shell (which is
// only postMessage; see browser/app-api.js). A view includes it with a script tag before its
// own scripts (`../view-lib/app.js`), and the builder inlines it into the page.
//
// Core interface:
//
//   app.ready()                    the view is listening; the context arrives first, then
//                                  anything that came in while it loaded
//   app.call(...parts)             send bytes to the guest; returns a promise of its answer
//   app.onRender(fn)               fn(bytes): renders not handled below
//   app.onContext(fn)              fn(ctx): the node's context (render type 0)
//   app.conv({ room } | { to })    which conversation is open (ids in hex), or none; calls
//                                  started from the shell's call bar go there
//   app.contact(peer)              ask the shell to make a known peer a contact
//   app.nameOf(key)                a peer's (or this node's) nick, or the start of its key
//
// The view side of guest-lib/room-pipe.js:
//
//   app.cast(room, ...parts)       send a frame to every linked member of a room
//   app.tell(room, to, ...parts)   send a frame to one member
//   app.onFrame(fn)                fn(from, room, body): a frame from a member of `room`
//
// Rooms and peers are identified by id in hex, as in the context.

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}
/** Concatenate byte arrays (or plain arrays of bytes) into a new buffer. */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const app = (() => {
  /** Render types defined by guest-lib: the context, and a room-pipe frame
   *  `[from 32][room 32][body]`. Other types are the app's own. */
  const RENDER_CONTEXT = 0, RENDER_FRAME = 1;
  /** room-pipe.js's calls: cast `[frame]` and tell `[to 32][frame]`, frame = `[room 32][body]`. */
  const ASK_CAST = 1, ASK_TELL = 2;

  const dec = new TextDecoder();
  const bytesOf = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));
  const post = (msg) => window.parent.postMessage(msg, "*");

  /** Listeners. Context and frame renders go to their own listener, the rest to `render`. */
  const heard = { render: null, context: null, frame: null };
  /** The last context, for `nameOf`. */
  let ctx = null;
  /** Pending calls by id. */
  const calls = new Map();
  let nextCall = 1;

  /** Send the concatenated parts to the guest's `ui` op. The shell answers every call, so
   *  the promise always settles: with the guest's answer (possibly empty), or its error. */
  function call(...parts) {
    const bytes = concat(...parts);
    return new Promise((resolve, reject) => {
      const id = nextCall++;
      calls.set(id, { resolve, reject });
      window.parent.postMessage({ type: "call", id, bytes }, "*", [bytes.buffer]);
    });
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent) return;
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "answer") {
      const waiting = calls.get(msg.id);
      if (!waiting) return;
      calls.delete(msg.id);
      if (msg.payload === undefined) waiting.reject(new Error(String(msg.error ?? "the app's guest did not answer")));
      else waiting.resolve(bytesOf(msg.payload));
      return;
    }
    if (msg.type !== "render") return;
    const p = bytesOf(msg.payload);
    if (p[0] === RENDER_CONTEXT) {
      ctx = JSON.parse(dec.decode(p.subarray(1)));
      heard.context?.(ctx);
    } else if (p[0] === RENDER_FRAME && p.length >= 65 && heard.frame) {
      heard.frame(toHex(p.subarray(1, 33)), toHex(p.subarray(33, 65)), p.subarray(65));
    } else if (heard.render) heard.render(p);
  });

  return {
    ready: () => post({ type: "ready" }),
    call,
    onRender: (fn) => { heard.render = fn; },
    onContext: (fn) => { heard.context = fn; },
    conv: (open = {}) => post({ type: "conv", room: open.room, to: open.to }),
    contact: (peer) => post({ type: "contact", peer }),
    nameOf: (key) => (key === ctx?.me ? ctx.nick : ctx?.nicks[key]) || key.slice(0, 8),
    // Fire-and-forget; guest errors show in the shell's Diagnostics.
    cast: (room, ...parts) => { call([ASK_CAST], fromHex(room), ...parts).catch(() => {}); },
    tell: (room, to, ...parts) => { call([ASK_TELL], fromHex(to), fromHex(room), ...parts).catch(() => {}); },
    onFrame: (fn) => { heard.frame = fn; },
  };
})();
