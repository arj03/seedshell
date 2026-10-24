// Keeps an app's view off the network.
//
// The iframe sandbox (shell.js `mountView`) gives a view an opaque origin, which keeps it
// away from the shell's DOM, keys and storage, but not from the network: a blob: document
// inherits the shell page's CSP, which must allow WebSockets to any relay. A view is granted
// nothing of its own (the app's reach is its guest's, per its manifest), so `guardView`
// adds two things to the view's page before it loads:
//
//   a policy   prepended to the head (`VIEW_POLICY`, `VIEW_SCRIPT_POLICY`). Policies stack,
//              so this only restricts further: no requests, no frames, no form submission,
//              and no scripts except the prelude and the scripts it runs.
//   a prelude  the one script the parser may run (allowed by hash). It deletes
//              RTCPeerConnection, since CSP can't stop WebRTC from contacting the STUN/TURN
//              servers a script names (Chromium doesn't support the `webrtc` directive). It
//              then runs the view's scripts in order.
//
// The view's scripts are "held" (given a non-executable type) so only the prelude can run
// them. With 'strict-dynamic', a script runs only if it is the hashed prelude or was created
// by a running script, so the prelude runs first in every document this policy reaches: the
// view, a srcdoc frame it creates, or a blob it navigates to. Inline handlers (`onclick=`)
// and `javascript:` URLs don't run; views use `addEventListener`.
//
// Known gap: `<link rel="preconnect">` and `dns-prefetch` aren't covered by CSP, so a view
// can leak a little at a time through hostnames it chooses. It receives nothing back.
//
// Browser only (DOMParser, WebCrypto).

/** The type given to held scripts, and the attribute that saves their original type. */
const HELD = "application/x-view-script";
const HELD_TYPE = "data-view-type";

/** Script types a browser executes (per HTML's "prepare the script element"). Other types
 *  are data blocks and are left alone. */
const RUNS = new Set(["", "module", "importmap", "application/ecmascript", "application/javascript",
  "application/x-ecmascript", "application/x-javascript", "text/ecmascript", "text/javascript",
  "text/javascript1.0", "text/javascript1.1", "text/javascript1.2", "text/javascript1.3",
  "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript"]);

/** The prelude. It removes WebRTC (and bails out, running nothing, if it can't), then
 *  re-creates each held script with its original type so it runs. The MutationObserver
 *  fires at each script boundary during parsing, so scripts still run in document order.
 *
 *  The policy names this text by hash, and it must not contain `</script`. */
const PRELUDE = `(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    delete globalThis[name];
    if (name in globalThis) return;
  }
  const run = (held) => {
    const live = document.createElement("script");
    for (const a of held.attributes) {
      if (a.name !== "type" && a.name !== ${JSON.stringify(HELD_TYPE)}) live.setAttribute(a.name, a.value);
    }
    const type = held.getAttribute(${JSON.stringify(HELD_TYPE)});
    if (type !== null) live.setAttribute("type", type);
    live.text = held.text;
    held.replaceWith(live);
  };
  const sweep = () => {
    for (const held of document.querySelectorAll(${JSON.stringify(`script[type="${HELD}"]`)})) run(held);
  };
  const parsing = new MutationObserver(sweep);
  parsing.observe(document, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", () => { sweep(); parsing.disconnect(); }, { once: true });
})();`;

const preludeHash = btoa(String.fromCharCode(
  ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PRELUDE)))));

/** The view's main policy. `default-src 'none'` blocks every request (fetch, XHR, WebSocket,
 *  WebTransport, beacons, images, styles, fonts, prefetch). It allows back only what needs no
 *  network: inline styles, `data:`/`blob:` images and media, `data:` fonts and blob workers
 *  (which inherit this policy and have no WebRTC). shell.html's policy also applies, so it
 *  must allow these too. */
export const VIEW_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${preludeHash}' 'strict-dynamic' 'wasm-unsafe-eval'`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** A second policy. Under 'strict-dynamic', a running script may load a script from any
 *  URL (also `import()` and `importScripts`), and shell.html's policy allows the page's own
 *  server, so a view could leak data in a request URL there. This policy allows inline
 *  script only; since a script must pass both policies, scripts a view creates can run but
 *  can't load anything. `worker-src` is repeated because it would otherwise fall back to
 *  this `script-src`, which has no `blob:`. */
export const VIEW_SCRIPT_POLICY = "script-src 'unsafe-inline' 'wasm-unsafe-eval'; worker-src blob:";

/** Return the view's HTML with the policies and prelude prepended to its head, and every
 *  executable inline script held for the prelude. Scripts with `src` are left for the policy
 *  to refuse (the builder inlines a view's scripts; see scripts/app-source.mjs `readView`).
 *  Fails safe: any script missed here is still blocked by the policy. */
export function guardView(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const script of doc.querySelectorAll("script:not([src])")) {
    if (!(script instanceof HTMLScriptElement)) continue;
    const type = script.getAttribute("type");
    if (!RUNS.has((type ?? "").trim().toLowerCase())) continue;
    if (type !== null) script.setAttribute(HELD_TYPE, type);
    script.setAttribute("type", HELD);
  }
  // Declare UTF-8 first, since the prelude could push the author's charset meta past the
  // point where browsers look for it.
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  // One meta per policy; two policies in one element would be parsed as one.
  const policies = [VIEW_POLICY, VIEW_SCRIPT_POLICY].map((content) => {
    const policy = doc.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = content;
    return policy;
  });
  const prelude = doc.createElement("script");
  prelude.text = PRELUDE;
  doc.head.prepend(charset, ...policies, prelude);
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}
