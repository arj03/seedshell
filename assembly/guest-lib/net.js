// What any guest that reaches the network writes the same way: the transport's `send`, and
// keys as hex. Who is linked a guest reads off the node's context (context.js), which the
// shell tells it each time that changes. The offline builder
// (scripts/build-app-bundle.mjs) puts it in front of each guest that names it, after
// seedkernel's op-frame, which gives `callerOf`, `readOp`, `writeOp`, `utf8Encode` and
// `utf8Decode`. It is guest SOURCE, signed into each bundle, not a module anything imports,
// so the transport's argument layout is written once and every bundle still carries it.

/** The local service name the transport serves (browser/app-api.js `NET_PROTO`). */
const NET = "_net";

const HEX = "0123456789abcdef";
function toHex(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >>> 4] + HEX[b[i] & 15];
  return s;
}
function fromHex(h) {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/** Hand `payload` to the peer `to` (its 32-byte key) under the protocol id `proto`.
 *
 *  The transport's `send` op takes `[noReply u8]` then `[to][proto][payload]` as blobs,
 *  each `[len u32][bytes]`; the envelope in front is `writeOp`'s, so a guest writes the
 *  arguments and never the framing. The host prepends this app's own id as the caller, so
 *  the transport can tell an app's request from the platform's own events.
 *
 *  `noReply` is 1 unless `reply` is asked for: the frame is handed to the wire and the call
 *  answers `[1]` without waiting for the far end. With `reply` it waits for what the far
 *  end's guest answers the frame, and answers `[1][that]`, or `[0]` for a peer that could
 *  not be reached or gave no answer. There is no deadline field, because the host carries
 *  the invocation's own remaining segment across every handoff (seedkernel §12.3). The
 *  transport dials a peer it has an address for, and a peer it cannot reach is not
 *  reached. */
function netSend(to, proto, payload, reply = false) {
  const args = new Uint8Array(1 + 4 + 32 + 4 + proto.length + 4 + payload.length);
  let o = 0;
  const u32 = (v) => { args[o] = v >>> 24; args[o + 1] = (v >>> 16) & 255; args[o + 2] = (v >>> 8) & 255; args[o + 3] = v & 255; o += 4; };
  args[o++] = reply ? 0 : 1;
  u32(32); args.set(to, o); o += 32;
  u32(proto.length); for (let i = 0; i < proto.length; i++) args[o++] = proto.charCodeAt(i);
  u32(payload.length); args.set(payload, o);
  return host.call(NET, writeOp("send", args));
}
