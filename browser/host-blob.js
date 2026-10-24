// Fetch the vendored host blob (seedkernel's build/host.skb). shell.html loads this as its
// own module ahead of shell.js, so the download starts while shell.js's imports are still
// loading. shell.js imports the same promise.
//
// "no-cache" revalidates each load: a rebuilt blob is never stale, and an unchanged one
// costs only a conditional request.
const url = new URL("./vendor/host.skb", import.meta.url);
export const hostBlob = fetch(url, { cache: "no-cache" }).then(async (res) => {
  // Fail clearly here rather than later as a "malformed blob".
  if (!res.ok) throw new Error(`${url.href} was not served (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
});
