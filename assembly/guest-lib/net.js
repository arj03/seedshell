// Shared guest source for any guest that uses the network: the transport's `send`, and hex
// helpers. The builder concatenates it after seedkernel's op-frame prelude (which provides
// `callerOf`, `readOp`, `writeOp`, `utf8Encode` and `utf8Decode`), so it is signed into each
// bundle that lists it rather than imported.

/** The transport's service name (browser/app-api.js `NET_PROTO`). */
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

/** Send `payload` to peer `to` (32-byte key) under protocol `proto`.
 *
 *  The transport's `send` op takes `[noReply u8]`, then `to`, `proto` and `payload` as
 *  `[len u32][bytes]` blobs. Without `reply` it answers `[1]` once the frame is handed to
 *  the wire. With `reply` it waits for the far guest's answer: `[1][answer]`, or `[0]` if
 *  the peer was unreachable or did not answer. No deadline is passed; the host carries the
 *  invocation's own deadline across the call (§12.3). */
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
