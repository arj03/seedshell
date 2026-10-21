// The shell app, as the pages that load it speak to it. Its guest is assembly/shell-app,
// built like any app (scripts/build-app-bundle.mjs) and loaded at boot by its pin, from the
// module the build writes beside this file (browser/shell-bundle.js).
//
// It is how one page talks to another. A peer's frame reaches only a bundle that claims
// its protocol id (seedkernel §12.10), so what two pages say to each other needs a bundle
// to hold the claim, and `_net` so this page's word reaches that peer. This app holds three
// claims, and what rides each is told apart by the id it arrived under, not by its shape:
//
//   shell/v1   what a page tells another about itself: `{ nick }`, what it calls itself,
//              and `{ peer }`, that it added or removed the other as a peer.
//   call/v1    a call's signaling. A call's audio and video ride a peer connection the PAGE
//              owns (media-rtc.js), one per peer, separate from the transport's: the
//              transport's connections carry bytes and are the host's to hold. That media
//              connection still needs signaling, and this is its path.
//   offer/v1   a signed bundle one page offers another. The app that would take it is the
//              thing offered, so until one is accepted nothing else could hold this claim.
//
// All three ride the node's own channel and are authenticated by it, so none needs a relay
// once the peers are linked, and nobody on the relay can inject into any.

/** The wire protocols, in the order assembly/shell-app/app.json claims them. */
export const SHELL_PROTO = "shell/v1";
export const CALL_PROTO = "call/v1";
export const OFFER_PROTO = "offer/v1";

/** The page's three local ops, each `[to 32][bytes …]`, sent to that peer under one of the
 *  protocols: `tell` under `SHELL_PROTO`, `signal` under `CALL_PROTO` and `offer` under
 *  `OFFER_PROTO`. The op is what names the protocol, so the page spells no id into what it
 *  sends. `tell` answers whether the peer's page got it: `[1]…` once that page has answered,
 *  and `[0]` for a peer that could not be reached or gave no answer. The other two wait for
 *  nothing. */
export const SHELL_OP_TELL = "tell";
export const SHELL_OP_SIGNAL = "signal";
export const SHELL_OP_OFFER = "offer";
