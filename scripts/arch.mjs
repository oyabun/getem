// Finds out which chips each app's main executable really supports (arm64, x86_64 or both).
// Homebrew only says "arm64 only" when a cask is marked so; for a download shared by both chips it can't tell a
// universal app from an Apple-Silicon-only one. For .zip downloads we read the Mach-O header of the app's main
// executable straight out of the archive with HTTP range requests (a few hundred KB per app, never the whole file).
// Results are cached in data/arch.json, which build.mjs reads.   Usage: npm run arch [-- --refresh] [id ...]
import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync, constants } from "node:zlib";

const root = new URL("..", import.meta.url);
const path = (p) => new URL(p, root);
const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const only = new Set(args.filter((a) => !a.startsWith("--")));

const CPU = { 0x01000007: "x86_64", 0x0100000c: "arm64" };

async function range(url, start, end) {
  const res = await fetch(url, { redirect: "follow", headers: { range: `bytes=${start}-${end}`, "user-agent": "getem-sh-arch-check" }, signal: AbortSignal.timeout(30000) });
  if (res.status !== 206) throw new Error(`no range support (${res.status})`);
  const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") || "")?.[1] || 0);
  return { buf: Buffer.from(await res.arrayBuffer()), total };
}

// Parse the zip's central directory into entries { name, method, csize, usize, offset }.
async function zipEntries(url) {
  const probe = await range(url, 0, 0).catch(() => null);
  if (!probe?.total) throw new Error("unknown size");
  const total = probe.total;
  const tailLen = Math.min(total, 70000);
  const { buf: tail } = await range(url, total - tailLen, total - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end-of-central-directory");
  let cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16), count = tail.readUInt16LE(eocd + 10);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error("zip64 not handled");
  const cd = cdOff >= total - tailLen ? tail.subarray(cdOff - (total - tailLen), cdOff - (total - tailLen) + cdSize) : (await range(url, cdOff, cdOff + cdSize - 1)).buf;
  const entries = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42), name: cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// First bytes of one entry's contents.
async function entryHead(url, e, want = 4096) {
  const { buf: lh } = await range(url, e.offset, e.offset + 29);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local header");
  const dataStart = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (e.method === 0) return (await range(url, dataStart, dataStart + want - 1)).buf;
  if (e.method !== 8) throw new Error(`method ${e.method}`);
  const take = Math.min(e.csize, 80000);
  const { buf } = await range(url, dataStart, dataStart + take - 1);
  // The compressed stream is cut off on purpose; flush whatever has been decoded so far.
  return inflateRawSync(buf, { finishFlush: constants.Z_SYNC_FLUSH }).subarray(0, want);
}

function machoArchs(b) {
  const magic = b.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const n = b.readUInt32BE(4), size = magic === 0xcafebabe ? 20 : 32, out = [];
    for (let i = 0; i < n && 8 + i * size + 4 <= b.length; i++) out.push(CPU[b.readUInt32BE(8 + i * size)] || `cpu${b.readUInt32BE(8 + i * size)}`);
    return out;
  }
  if (b.readUInt32LE(0) === 0xfeedfacf) return [CPU[b.readUInt32LE(4)] || `cpu${b.readUInt32LE(4)}`];
  throw new Error("not a Mach-O file");
}

async function check(app) {
  const url = app.arm.url;
  const entries = await zipEntries(url);
  // The main executable: the biggest file directly inside a top-level .app's Contents/MacOS.
  const exes = entries.filter((e) => /^[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(e.name) || /^[^/]+\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(e.name));
  if (!exes.length) throw new Error("no executable found");
  const exe = exes.sort((a, b) => b.usize - a.usize)[0];
  return { archs: machoArchs(await entryHead(url, exe)), exe: exe.name.split("/").pop(), checked: new Date().toISOString().slice(0, 10), version: app.version };
}

async function main() {
  const catalog = JSON.parse(await readFile(path("public/catalog.json"), "utf8"));
  let cache = {};
  try { cache = JSON.parse(await readFile(path("data/arch.json"), "utf8")); } catch {}
  // Only apps with one download shared by both chips are in doubt; separate arm/intel builds are native on each.
  const todo = catalog.apps.filter((a) => a.kind === "app" && a.arm?.url && a.intel?.url && a.arm.url === a.intel.url
    && /\.zip(\?|$)/i.test(a.arm.url.split("?")[0] + (a.arm.url.includes("extension=zip") ? ".zip" : ""))
    && (only.size ? only.has(a.id) : refresh || cache[a.id]?.version !== a.version));
  console.log(`arch: checking ${todo.length} zip downloads`);
  let done = 0;
  const queue = [...todo];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const app = queue.shift();
      try { cache[app.id] = await check(app); }
      catch (err) { cache[app.id] = { error: String(err.message || err), version: app.version }; }
      if (++done % 10 === 0) console.log(`arch: ${done}/${todo.length}`);
    }
  }));
  await writeFile(path("data/arch.json"), JSON.stringify(cache, null, 1) + "\n");
  const ok = Object.values(cache).filter((v) => v.archs);
  const tally = {};
  for (const v of ok) { const k = v.archs.slice().sort().join("+"); tally[k] = (tally[k] || 0) + 1; }
  console.log(`arch: ${ok.length} verified`, tally, `${Object.values(cache).filter((v) => v.error).length} could not be read`);
}

main().catch((err) => { console.error(err); process.exit(1); });
