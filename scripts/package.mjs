// Packages the current build for a release, into release/:
//
//   seedshell-<version>.zip   browser/ as built, the page and its vendored runtime, under
//                             seedshell/: unzip it on any static web server.
//   chat.skb, jam.skb, hello.skb
//                             the apps, each a signed bundle to drop on the Apps tab.
//
// The radio is left out: it runs from a checkout (npm run radio), not from a page.
// Run `npm run build` first; scripts/release.mjs does both.
import { crc32, deflateRawSync } from "node:zlib";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const browser = join(root, "browser");
const out = join(root, "release");
export const APPS = ["chat", "jam", "hello"];

for (const need of ["browser/vendor", "browser/shell-bundle.js", ...APPS.map((a) => `bundle/${a}.skb`)]) {
  if (!existsSync(join(root, need))) throw new Error(`${need} is missing; run npm run build first`);
}

/** Every file under `dir`, as paths relative to it with forward slashes, sorted. */
function walk(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((p) => statSync(join(dir, p)).isFile())
    .map((p) => p.split("\\").join("/"))
    .sort();
}

/** A zip of `entries` ({ name, data }), deflated, with every date 1980-01-01 so the same
 *  files make the same bytes. */
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const fields = (b, at) => {
      b.writeUInt16LE(20, at);              // version needed
      b.writeUInt16LE(0x0800, at + 2);      // UTF-8 names
      b.writeUInt16LE(8, at + 4);           // deflate
      b.writeUInt16LE(0, at + 6);           // time
      b.writeUInt16LE(0x21, at + 8);        // date: 1980-01-01
      b.writeUInt32LE(crc32(data), at + 10);
      b.writeUInt32LE(packed.length, at + 14);
      b.writeUInt32LE(data.length, at + 18);
      b.writeUInt16LE(nameBytes.length, at + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    fields(local, 4);
    parts.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);             // version made by
    fields(entry, 6);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const name = `seedshell-${version}.zip`;
const files = walk(browser).map((p) => ({ name: `seedshell/${p}`, data: readFileSync(join(browser, p)) }));
writeFileSync(join(out, name), zip(files));
for (const app of APPS) copyFileSync(join(root, "bundle", `${app}.skb`), join(out, `${app}.skb`));
console.log(`${relative(root, out)}/: ${name} (${files.length} files), ${APPS.map((a) => `${a}.skb`).join(", ")}`);
