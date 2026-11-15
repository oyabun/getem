// Finds each catalog app in nixpkgs, for the page's Nix config (nix-darwin, Home Manager, NixOS).
// Reads the package list behind search.nixos.org (one file per channel, ~10 MB compressed) and matches apps by their
// homepage or GitHub repo, or by name when the websites agree. data/nix-overrides.json fixes what that gets wrong
// ("app-id": "attr", or null for "not in nixpkgs"). Results go to data/nix.json, which build.mjs reads: per app, the
// package to use on macOS (`darwin`) and on Linux (`linux`), either missing when nixpkgs doesn't build it there.
//   Usage: npm run nix   (run after npm run build, so new apps are in public/catalog.json)
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";

const CHANNEL = "nixos-26.05";
// The systems a package must build for: Apple Silicon Macs, and the usual NixOS PC.
const SYSTEM = { darwin: "aarch64-darwin", linux: "x86_64-linux" };
const root = new URL("..", import.meta.url);
const path = (p) => new URL(p, root);

const url = (u) => (u || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[/#?].*$/, (m) => (m.startsWith("/") ? m : "")).replace(/\/+$/, "");
const site = (u) => url(u).split("/")[0].split(".").slice(-2).join(".");
const repoOf = (u) => /github\.com\/([^/]+\/[^/#?]+)/.exec(u || "")?.[1].toLowerCase().replace(/\.git$/, "");
// Top-level packages only (plus the JetBrains set): rPackages.signal or emacsPackages.hush are libraries, not the app.
// Language runtimes are one app per version: nixpkgs names those by the major (or minor) version, so read it off the app.
const VERSIONED = { node: (v) => `nodejs_${v.split(".")[0]}`, python3: (v) => `python3${v.split(".")[1]}`, go: (v) => `go_${v.split(".").slice(0, 2).join("_")}`, temurin: (v) => `temurin-bin-${v.split(".")[0]}` };
const versioned = (app) => VERSIONED[(app.variantOf || app.id).replace(/@.*$/, "")]?.(app.version);
const topLevel = (attr) => !attr.includes(".") || attr.startsWith("jetbrains.");

async function main() {
  console.log(`nixpkgs: downloading the ${CHANNEL} package list…`);
  const res = await fetch(`https://channels.nixos.org/${CHANNEL}/packages.json.br`);
  if (!res.ok) throw new Error(`packages.json.br: HTTP ${res.status}`);
  // The server marks the file as brotli-encoded, so fetch usually unpacks it already; unpack it here if not.
  const body = Buffer.from(await res.arrayBuffer());
  const pkgs = JSON.parse(body[0] === 0x7b ? body : brotliDecompressSync(body)).packages;
  const catalog = JSON.parse(await readFile(path("public/catalog.json"), "utf8"));
  const overrides = JSON.parse(await readFile(path("data/nix-overrides.json"), "utf8"));

  // Platforms are system names or patterns ({ kernel: { families: { darwin } } }); a package that lists none builds
  // everywhere, as in nixpkgs itself (the JetBrains IDEs). This list is evaluated on Linux, so a package broken only on
  // macOS still looks fine here: verify() below asks Nix itself.
  const fits = (p, os) => (typeof p === "string" ? p === SYSTEM[os] : Boolean(p?.kernel?.families?.[os] || p?.kernel?.name === os));
  const builds = (attr, os) => {
    const m = pkgs[attr].meta || {};
    if (m.broken || m.knownVulnerabilities?.length || (m.badPlatforms || []).some((p) => fits(p, os))) return false;
    return !m.platforms?.length || m.platforms.some((p) => fits(p, os));
  };
  const byHome = new Map(), byRepo = new Map(), byName = new Map();
  const add = (map, key, attr) => { if (key) map.set(key, [...(map.get(key) || []), attr]); };
  for (const [attr, p] of Object.entries(pkgs)) {
    if (!topLevel(attr)) continue;
    for (const h of [].concat(p.meta?.homepage || [])) { add(byHome, url(h), attr); add(byRepo, repoOf(h), attr); }
    add(byName, (p.pname || "").toLowerCase(), attr);
    if (p.pname?.toLowerCase() !== attr.toLowerCase()) add(byName, attr.toLowerCase(), attr);
  }
  // Several packages can share a homepage (foo, foo-bin, foo-unwrapped): prefer one that builds on macOS, then the
  // shortest name, which is usually the one meant for people rather than a building block.
  const best = (attrs) => [...new Set(attrs)].filter((a) => !/-unwrapped$|-src$/.test(a))
    .sort((a, b) => builds(b, "darwin") - builds(a, "darwin") || a.length - b.length)[0];

  const out = {};
  let matched = 0;
  for (const app of catalog.apps) {
    if (app.kind === "builtin") continue;
    let attr;
    if (app.id in overrides) attr = overrides[app.id];
    else if (versioned(app)) attr = versioned(app);
    else {
      const strong = [...(byHome.get(url(app.homepage)) || []), ...(byRepo.get(app.repo?.toLowerCase()) || [])];
      // A name match counts only when the package's website is the app's: "tabby" is also an AI coding server.
      const names = [app.brew, app.id, app.name.toLowerCase().replace(/\s+/g, "-")].filter(Boolean).map((n) => n.replace(/@.*$|-app$/, ""));
      const loose = names.flatMap((n) => byName.get(n) || []).filter((a) => [].concat(pkgs[a].meta?.homepage || []).some((h) => site(h) === site(app.homepage)));
      attr = best(strong.length ? strong : loose) || null;
    }
    if (!attr) continue;
    if (!pkgs[attr]) { console.warn(`  ${app.id}: "${attr}" is not in ${CHANNEL} yet`); continue; }
    // One package per system: the -bin build is often the only one for macOS (ghostty-bin), the source build the one
    // for Linux (ghostty).
    const pick = (os) => [attr, `${attr}-bin`, attr.replace(/-bin$/, "")].find((a) => pkgs[a] && builds(a, os));
    const entry = { darwin: pick("darwin"), linux: pick("linux") };
    if (!entry.darwin && !entry.linux) continue;
    const unfree = (a) => a && [].concat(pkgs[a].meta?.license || []).some((l) => l.free === false);
    out[app.id] = { ...entry, unfree: Boolean(unfree(entry.darwin) || unfree(entry.linux)) };
    matched++;
  }
  for (const miss of await verify(out)) {
    const [id, os] = miss.split(" ");
    console.warn(`  ${id}: ${out[id][os]} doesn't evaluate on ${SYSTEM[os]}, left out there`);
    delete out[id][os];
    if (!out[id].darwin && !out[id].linux) { delete out[id]; matched--; }
  }
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path("data/nix.json"), JSON.stringify({ channel: CHANNEL, apps: sorted }, null, 1) + "\n");
  const all = catalog.apps.filter((a) => a.kind !== "builtin").length;
  const mac = Object.values(out).filter((v) => v.darwin).length;
  console.log(`nix: ${matched} of ${all} apps are in nixpkgs, ${mac} of them build on macOS (data/nix.json)`);
}

// Ask Nix whether each package is available on its system (meta.available: not broken, not insecure, built for it), as
// darwin-rebuild or nixos-rebuild would. One bad name fails the whole rebuild, so this is worth the wait (a few minutes
// the first time, for the nixpkgs download). Uses nix-instantiate when it's installed, or the nixos/nix Docker image.
async function verify(apps) {
  const dir = await mkdtemp(join(tmpdir(), "getem-nix-"));
  await writeFile(join(dir, "apps.json"), JSON.stringify(apps));
  await writeFile(join(dir, "check.nix"), `
let
  src = builtins.fetchTarball "https://channels.nixos.org/${CHANNEL}/nixexprs.tar.xz";
  pkgs = os: import src { system = { darwin = "${SYSTEM.darwin}"; linux = "${SYSTEM.linux}"; }.\${os}; config.allowUnfree = true; };
  lib = (pkgs "linux").lib;
  ok = os: attr: let r = builtins.tryEval (let p = lib.attrByPath (lib.splitString "." attr) null (pkgs os); in p != null && (p.meta.available or true)); in r.success && r.value;
in lib.concatLists (lib.mapAttrsToList (id: v: map (os: "\${id} \${os}") (builtins.filter (os: v ? \${os} && !(ok os v.\${os})) [ "darwin" "linux" ]))
  (builtins.fromJSON (builtins.readFile ./apps.json)))
`);
  const run = (cmd, args) => new Promise((done) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => done(err ? { err: stderr || err.message } : { out: stdout })));
  const eval_ = ["--eval", "--strict", "--json"];
  console.log("nix: checking every package with Nix…");
  let r = await run("nix-instantiate", [...eval_, join(dir, "check.nix")]);
  if (r.err && /ENOENT/.test(r.err)) r = await run("docker", ["run", "--rm", "-v", `${dir}:/w`, "nixos/nix:latest", "nix-instantiate", ...eval_, "/w/check.nix"]);
  await rm(dir, { recursive: true, force: true });
  if (r.err) { console.warn(`  could not run Nix, so nothing was verified (install Nix or Docker):\n  ${r.err.trim().split("\n").pop()}`); return []; }
  return JSON.parse(r.out);
}

main().catch((err) => { console.error(err); process.exit(1); });
