// The contract between this shell and the apps it hosts. shell.js gates and drives every
// bundle through this file, and scripts/build-app-bundle.mjs uses it to refuse to sign a
// bundle the shell would refuse to run.
//
// An app is a signed bundle (seedkernel §12.4) with three parts:
//
//   guest     the app's behaviour. The shell hands it opaque bytes: a peer's frame under a
//             protocol the app claims, the node's context (`ctx`), and calls from the app's
//             view (`ui`). Answers go to the view, as renders or as the reply to a call.
//   view      the app's UI, an HTML page in a sandboxed iframe. It talks to the shell only by
//             postMessage: `ready`, `call`, `conv` and `contact`. The shell sends it `render`
//             and `answer`.
//   modules   optional pure-compute wasm the guest drives. The shell never sees them.
//
// Frame, render and call formats are all the app's own, so a new app version never needs a
// shell change. What the shell owns is the node's identity, rooms, peers, contacts and
// nicks, which every app is told as the context, and calls, since a sandboxed view cannot
// get the camera or microphone.
//
// No imports: both the browser and the offline builder load this file.

/** The contract version. An app's manifest names the version it was built for
 *  (`guest.config.shell.api`), and the shell refuses any other. */
export const APP_API = 3;

/** The local service name the transport bundle serves. `smoke.mjs` checks it against the
 *  transport bundle's own `services` claim. */
export const NET_PROTO = "_net";

/** Everything an app may list in `manifest.guest.requires`, with the words its consent row
 *  uses. A bundle that asks for anything else (e.g. `link` or `node`, which would let it be
 *  the network or sign as this node) is not installed. */
export const APP_GRANTS = {
    [NET_PROTO]: "the network",
    fs: "its own storage",
    timer: "a timer",
};

/** The shell's two ops into an app's guest, sent by name with seedkernel's op-frame:
 *
 *    ctx   the node's context as UTF-8 JSON (`contextJson`). Sent after install, whenever it
 *          changes, and when the view says it is ready. The answer is render bytes, or empty.
 *    ui    opaque bytes from the app's view (its `call`). The answer goes back to that call. */
export const APP_OP_CONTEXT = "ctx";
export const APP_OP_UI = "ui";

/** Renders held for a view (or head) that is not ready yet. Bounded because peer frames keep
 *  arriving whether or not anything is drawing them; the oldest are dropped. */
export const MAX_QUEUED_RENDERS = 512;

/** Read what the shell needs from a verified manifest, or throw saying why the bundle will
 *  not run. Everything comes from the signed `guest.config.shell` entry; author-written text
 *  is truncated to fit a row. */
export function appFacts(manifest) {
    const s = manifest.guest.config?.shell;
    if (typeof s !== "object" || s === null || Array.isArray(s))
        throw new Error("this bundle is not an app for this shell: its manifest has no `shell` entry");
    if (s.api !== APP_API)
        throw new Error(`this app was built for shell API ${JSON.stringify(s.api)}, and this shell speaks ${APP_API}`);
    for (const r of manifest.guest.requires) {
        if (!Object.hasOwn(APP_GRANTS, r))
            throw new Error(`this app reaches ${JSON.stringify(r)}, which this shell grants no app`);
    }
    // Apps serve peers, not each other, so a bundle offering a local service is refused.
    if ((manifest.services ?? []).length > 0)
        throw new Error("this app serves a local service, which this shell hosts no app for");
    const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
    return {
        name: text(s.name, 64) || manifest.app,
        version: text(s.version, 32),
        description: text(s.description, 200),
        ui: typeof s.ui === "string" && s.ui !== "" ? s.ui : null,
        // Installing the bundle routes each claimed protocol to it (§12.10).
        protocols: [...(manifest.protocols ?? [])],
        requires: [...manifest.guest.requires],
    };
}

/** The hash a consent names: author, manifest, guest source and every module. Hashing the
 *  whole bundle means new guest code is a new consent, even if the modules are unchanged.
 *  `hash` is seedkernel's `genesisHash` with its crypto bound. */
export function bundleDigest(v, hash) {
    const enc = new TextEncoder();
    const parts = [v.author, enc.encode(JSON.stringify(v.manifest)), enc.encode(v.guestSource),
        ...v.modules.map((m) => m.wasm)];
    const all = new Uint8Array(32 * parts.length);
    parts.forEach((p, i) => all.set(hash(p), 32 * i));
    return hash(all);
}

/** The node's `admit` predicate (§12.5). A bundle is admitted if it matches one of `pins`
 *  (the shell's own boot bundles, `{ author, app }` with the author in hex), or if its digest
 *  is in `consents`. A consent is consumed when used, so one consent is one install. */
export function admitGate(pins, consents, hash) {
    return (v) => pins.some((p) => p.author === toHex(v.author) && p.app === v.manifest.app)
        || consents.delete(toHex(bundleDigest(v, hash)));
}

/** The context as the `ctx` op carries it, with all keys and ids in lowercase hex:
 *
 *    { api, me, nick, rooms: [{ id, name, members: [key] }], linked: [key],
 *      contacts: [key], nicks: { [key]: nick } }
 *
 *  Nicks are self-chosen and prove nothing; the key is what the channel authenticated.
 *  Everything is sorted so the same context always gives the same string, which lets the
 *  shell detect changes by comparing strings. Contact secrets are never included. */
export function contextJson({ me, nick, rooms, linked, contacts, nicks }) {
    const sorted = (keys) => [...keys].sort();
    return JSON.stringify({
        api: APP_API, me, nick,
        rooms: rooms.map((r) => ({ id: r.id, name: r.name, members: sorted(r.members) })),
        linked: sorted(linked),
        contacts: sorted(contacts),
        nicks: Object.fromEntries([...nicks].sort(([a], [b]) => (a < b ? -1 : 1))),
    });
}

/** Bytes to lowercase hex and back. */
export function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function fromHex(hex) {
    return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}
