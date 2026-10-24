// How one shell talks to another, through the shell boot bundle (assembly/shell-app). A
// peer's frame only reaches a bundle that claims its protocol (§12.10), so the shell needs a
// bundle of its own to hold these three claims:
//
//   shell/v1   what a shell tells a peer about itself: `{ nick }`, and `{ peer }` (it added
//              or removed the peer as a contact).
//   call/v1    call signaling. The media itself rides peer connections the page owns
//              (media-rtc.js).
//   offer/v1   a signed bundle offered to a peer. Nothing else could hold this claim, since
//              the app that would handle it is the thing being offered.
//
// All three ride the node's authenticated channel, so no relay is needed once peers are
// linked, and nothing on the relay can inject into them.

/** The wire protocols, in the order assembly/shell-app/app.json claims them. */
export const SHELL_PROTO = "shell/v1";
export const CALL_PROTO = "call/v1";
export const OFFER_PROTO = "offer/v1";

/** The guest's three ops, each `[to 32][bytes…]`: `tell` sends under shell/v1, `signal`
 *  under call/v1 and `offer` under offer/v1. `tell` waits for the peer and answers `[1]…` if
 *  its shell received it, `[0]` if not; the other two are fire-and-forget. */
export const SHELL_OP_TELL = "tell";
export const SHELL_OP_SIGNAL = "signal";
export const SHELL_OP_OFFER = "offer";
