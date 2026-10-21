// The shell app's guest: how one page talks to another (browser/shell-app.js). It follows
// net.js, and holds the three claims its app.json lists, in that order, which is the order
// the builder hands them to it in `APP.protocols`.
//
// `handle` has two callers:
//
// - a peer's frame under any of the three, `[from 32][bytes …]`: answered with the bytes
//   themselves, which is what the page's `onInbound` receives (seedkernel §12.10), with
//   `from` and the claim beside them. The answer is the notification.
// - the page's three ops, each `[to 32][bytes …]`, handed to `_net` under the protocol the
//   op names. A `signal` and an `offer` wait for nothing. A `tell` waits for the peer's
//   guest to answer it, and answers what the transport does: the invocation is deferred
//   (seedkernel §12.3), so this realm is free for the next frame while it waits.
//
// The op names are browser/shell-app.js's `SHELL_OP_*`.

const [SHELL_PROTO, CALL_PROTO, OFFER_PROTO] = APP.protocols;
/** The two ops that send without waiting, by the protocol each sends under. Null-prototype,
 *  so `toString` is not one. */
const SENDS = Object.assign(Object.create(null), { signal: CALL_PROTO, offer: OFFER_PROTO });

async function handle(arg) {
  const { fromHost, body } = callerOf(arg);
  if (!fromHost) return arg.subarray(32);
  const { op, args } = readOp(body);
  const to = args.subarray(0, 32), bytes = args.subarray(32);
  if (op in SENDS) return await netSend(to, SENDS[op], bytes);
  if (op !== "tell") return new Uint8Array(0);
  globalThis.__deferred = true;
  return await netSend(to, SHELL_PROTO, bytes, true);
}
