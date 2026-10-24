// The shell boot bundle's guest (see browser/shell-app.js). It follows net.js, and gets its
// three claims in `APP.protocols`, in app.json order.
//
// `handle` has two callers:
// - a peer's frame, `[from 32][bytes…]`: answered with the bytes themselves, which reach the
//   page through its `onInbound` (§12.10).
// - the page's ops, `[to 32][bytes…]`: sent to `to` under the op's protocol. `tell` waits for
//   the peer's answer; the invocation is deferred (§12.3), so the realm stays free meanwhile.

const [SHELL_PROTO, CALL_PROTO, OFFER_PROTO] = APP.protocols;
/** The fire-and-forget ops and their protocols. Null prototype, so `"toString" in SENDS` is false. */
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
