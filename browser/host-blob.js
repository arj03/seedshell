// The host blob this page is served (seedkernel's build/host.skb, vendored), fetched by a
// <script> of its own ahead of shell.js in shell.html. Module scripts run in document order
// as each one's graph arrives, and this one imports nothing, so the download starts while
// shell.js's imports are still loading rather than after them. shell.js imports this same
// module, and so gets this same promise.
//
// "no-cache" revalidates on every load, so a rebuilt blob is never served stale, while an
// unchanged one costs a conditional request rather than its whole download again.
const url = new URL("./vendor/host.skb", import.meta.url);
export const hostBlob = fetch(url, { cache: "no-cache" }).then(async (res) => {
  // A page that does not serve the file answers with an error page, which would otherwise
  // fail later as a malformed blob.
  if (!res.ok) throw new Error(`${url.href} was not served (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
});
