// Builds the install catalog:
//   1. our curated list of Mac apps: data/apps.json, plus the hand-picked entries in data/extras.json
//      and data/builtins.json (nothing is fetched to decide which apps are listed)
//   2. matched against the Homebrew Cask API, or the publisher's release page, for current
//      versions, URLs and checksums
// Writes public/catalog.json (for the web page) and public/catalog.tsv (for install.sh).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const CASK_API = "https://formulae.brew.sh/api/cask.json";
const root = new URL("..", import.meta.url);
const path = (p) => new URL(p, root);

// Artifacts we know how to install, and where they go.
const INSTALLABLE = ["app", "pkg", "qlplugin", "screen_saver", "prefpane"];
// Artifacts we can safely ignore (CLI symlinks, completions, uninstall metadata).
const IGNORABLE = new Set([
  "target", "zap", "uninstall", "binary", "manpage", "command_wrapper",
  "bash_completion", "zsh_completion", "fish_completion",
  "generate_completions_from_executable",
  "uninstall_preflight_steps", "uninstall_postflight_steps",
]);
const OK_URL_SPECS = new Set(["branch", "only_path", "user_agent", "referer"]);

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "getem-sh-catalog-builder" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function loadList() {
  const list = JSON.parse(await readFile(path("data/apps.json"), "utf8"));
  console.log(`list: ${list.apps.length} curated apps in data/apps.json`);
  return list;
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const site = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, "").split(".").slice(-2).join("."); } catch { return ""; }
};
const repoIn = (cask, repo) =>
  `${cask.url || ""} ${cask.homepage || ""}`.toLowerCase().includes(`github.com/${repo.toLowerCase()}`);

function matcher(casks, overrides) {
  const byToken = new Map(casks.map((c) => [c.token, c]));
  const byRepo = new Map();
  const byName = new Map();
  for (const c of casks) {
    for (const f of [c.url, c.homepage]) {
      const m = /github\.com\/([^/]+\/[^/#?]+)/.exec(f || "");
      if (m) {
        const key = m[1].toLowerCase().replace(/\.git$/, "");
        if (!byRepo.has(key)) byRepo.set(key, c);
      }
    }
    for (const n of c.name || []) if (!byName.has(norm(n))) byName.set(norm(n), c);
  }
  return (app) => {
    if (app.slug in overrides) return overrides[app.slug] && byToken.get(overrides[app.slug]);
    const viaRepo = byRepo.get(app.repo.toLowerCase());
    if (viaRepo) return viaRepo;
    // Looser matches must agree on the website or the repo, to avoid same-name strangers.
    const loose = byToken.get(app.slug) || byName.get(norm(app.name));
    if (loose && (repoIn(loose, app.repo) || (app.homepage && site(app.homepage) === site(loose.homepage)))) return loose;
    return null;
  };
}

// Turn a cask into an install recipe, or explain why we can't.
// Variation keys name a macOS release, prefixed with arm64_ for Apple Silicon, listed newest
// first. The newest Intel key is the one that never comes after another key.
function newestIntelKey(casks) {
  const keys = new Set(), older = new Set();
  for (const c of casks) {
    const intel = Object.keys(c.variations || {}).filter((k) => !k.startsWith("arm64_") && !k.endsWith("_linux"));
    intel.forEach((k, i) => { keys.add(k); if (i > 0) older.add(k); });
  }
  return [...keys].find((k) => !older.has(k));
}

// Some casks fix file permissions in the staged download before installing (Blender's __pycache__).
// That only matters for Homebrew's own cleanup, so it is safe to skip; anything else is not.
const onlyPermissionSteps = (val) => val.every((v) => v.steps?.every((st) => st.type === "set_permissions"));

// Casks whose post-install step only sets up command-line shims (a kubectl symlink, OrbStack's CLI
// links). The apps offer to set these up themselves on first launch, so skipping them is safe.
const POSTFLIGHT_OK = new Set(["docker-desktop", "orbstack", "zoom", "teamviewer"]);   // zoom/teamviewer: just close the app their installer launches

function recipe(cask, intelKey) {
  if (cask.deprecated || cask.disabled) return { skip: "deprecated in Homebrew" };
  if (!cask.url) return { skip: "no download URL" };
  if (cask.container) return { skip: "nested container" };
  const specs = Object.keys(cask.url_specs || {}).filter((k) => !OK_URL_SPECS.has(k));
  if (specs.length) return { skip: `download needs ${specs.join(", ")}` };

  const found = [];
  for (const art of cask.artifacts) {
    for (const [kind, val] of Object.entries(art)) {
      if (INSTALLABLE.includes(kind)) found.push({ kind, val });
      else if (kind === "preflight_steps" && onlyPermissionSteps(val)) continue;
      else if (kind === "postflight_steps" && POSTFLIGHT_OK.has(cask.token)) continue;
      else if (!IGNORABLE.has(kind)) return { skip: `unsupported artifact "${kind}"` };
    }
  }
  if (found.length !== 1) return { skip: found.length ? "several artifacts" : "nothing to install" };
  const { kind, val } = found[0];
  const src = val[0];
  if (typeof src !== "string" || src.startsWith("/") || src.includes("$")) return { skip: "unusual artifact path" };
  const opts = typeof val[1] === "object" ? val[1] : {};
  if (kind === "pkg" && opts.choices) return { skip: "pkg with install choices" };
  const dest = (opts.target || src).split("/").pop();

  const arch = cask.depends_on?.arch?.[0]?.type;
  const arm = { url: cask.url, sha256: cask.sha256 };
  // The API's top-level values are for Apple Silicon on the newest macOS. Intel on the newest
  // macOS only differs when the cask has a variation for it; other variations are older releases.
  const intelVar = cask.variations?.[intelKey] || {};
  const intel = arch === "arm" ? null : { url: intelVar.url || cask.url, sha256: intelVar.sha256 || cask.sha256 };
  const minMacos = cask.depends_on?.macos?.[">="]?.[0] || null;
  const ua = cask.url_specs?.user_agent || null;

  return {
    kind, src, dest, arm, intel, minMacos,
    userAgent: ua === ":fake" ? "browser" : ua,
    referer: cask.url_specs?.referer || null,
  };
}

// Latest release of a GitHub repo and the asset matching `pattern` (exact name or with * wildcards),
// read from the release web pages: the REST API allows only 60 anonymous requests an hour.
async function latestRelease(repo, pattern, exclude) {
  const res = await fetch(`https://github.com/${repo}/releases/latest`, { method: "HEAD", redirect: "manual", headers: { "user-agent": "getem-sh-catalog-builder" } });
  const tag_name = decodeURIComponent((res.headers.get("location") || "").split("/releases/tag/")[1] || "");
  if (!tag_name) throw new Error(`${repo}: no releases`);
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const html = await fetchText(`https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag_name)}`);
  for (const item of html.split("<li").slice(1)) {
    const href = /href="([^"]*\/releases\/download\/[^"]+)"/.exec(item)?.[1];
    const file = href && decodeURIComponent(href.split("/").pop());
    if (!file || !re.test(file) || (exclude && file.includes(exclude))) continue;
    return { tag_name, asset: { url: `https://github.com${href}`, sha256: /sha256:([0-9a-f]{64})/.exec(item)?.[1] } };
  }
  return { tag_name, asset: null };
}

// Older releases carry no published checksum, so hash the publisher's file ourselves. The installer
// then pins that hash: it detects later tampering or corruption, but trusts this first download.
const hashCache = new Map();
async function sha256Of(url) {
  if (hashCache.has(url)) return hashCache.get(url);
  const sum = await sha256Download(url);
  hashCache.set(url, sum);
  return sum;
}
async function sha256Download(url) {
  const res = await fetch(url, { headers: { "user-agent": "getem-sh-catalog-builder" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
}

// Language runtimes that publish a plain installer package but no Homebrew cask. Each resolver finds the current
// version and its checksums; the result is a pkg, like the ones Homebrew casks use.
const RESOLVERS = {
  // The newest three long-term-support lines, newest first (the first one keeps the plain "node" id).
  async "node-lts"() {
    const index = JSON.parse(await fetchText("https://nodejs.org/dist/index.json"));
    const lines = [];
    for (const r of index) {
      const major = r.version.slice(1).split(".")[0];
      if (r.lts && !lines.some((l) => l.major === major)) lines.push({ major, v: r.version });
      if (lines.length === 3) break;
    }
    const out = [];
    for (const { major, v } of lines) {
      const sums = await fetchText(`https://nodejs.org/dist/${v}/SHASUMS256.txt`);
      const sha256 = new RegExp(`^([0-9a-f]{64})\\s+node-${v.replace(/\./g, "\\.")}\\.pkg$`, "m").exec(sums)?.[1];
      if (!sha256) throw new Error(`no checksum for node ${v}`);
      const dl = { url: `https://nodejs.org/dist/${v}/node-${v}.pkg`, sha256 };
      out.push({ suffix: major, label: `${major} LTS`, version: v.slice(1), src: "node.pkg", arm: dl, intel: dl });
    }
    return out;
  },
  // go.dev lists the two supported releases.
  async go() {
    const rels = JSON.parse(await fetchText("https://go.dev/dl/?mode=json")).filter((r) => r.stable).slice(0, 2);
    const mk = (f) => ({ url: `https://go.dev/dl/${f.filename}`, sha256: f.sha256 });
    return rels.map((rel) => {
      const pick = (arch) => rel.files.find((f) => f.os === "darwin" && f.arch === arch && f.kind === "installer");
      const [a, i] = [pick("arm64"), pick("amd64")];
      if (!a || !i) throw new Error(`go ${rel.version}: no macOS installers`);
      const minor = rel.version.replace(/^go/, "").split(".").slice(0, 2).join(".");
      return { suffix: minor, label: minor, version: rel.version.replace(/^go/, ""), src: "go.pkg", arm: mk(a), intel: mk(i) };
    });
  },
  // The newest patch release of each of the four newest Python 3 minors that python.org ships as a macOS installer.
  async python() {
    const page = await fetchText("https://www.python.org/downloads/macos/");
    const newest = new Map();
    for (const m of page.matchAll(/python-(3\.(\d+)\.(\d+))-macos11\.pkg/g)) {
      const cur = newest.get(+m[2]);
      if (!cur || +m[3] > cur.patch) newest.set(+m[2], { version: m[1], minor: `3.${m[2]}`, patch: +m[3] });
    }
    const picks = [...newest.entries()].sort((x, y) => y[0] - x[0]).slice(0, 4).map(([, v]) => v);
    if (!picks.length) throw new Error("python: no macOS installer listed");
    const out = [];
    for (const { version, minor } of picks) {
      const url = `https://www.python.org/ftp/python/${version}/python-${version}-macos11.pkg`;
      const dl = { url, sha256: await sha256Of(url) };
      out.push({ suffix: minor, label: minor, version, src: "python.pkg", arm: dl, intel: dl });
    }
    return out;
  },
};

const tsvField = (v) => (v == null || v === "" || v === "no_check" ? "-" : String(v).replace(/[\t\n]/g, " "));

async function main() {
  try { for (const [u, h] of Object.entries(JSON.parse(await readFile(path("data/hashes.json"), "utf8")))) hashCache.set(u, h); } catch {}
  const overrides = JSON.parse(await readFile(path("data/overrides.json"), "utf8"));
  const list = await loadList();
  console.log("casks: downloading Homebrew Cask API…");
  const casks = JSON.parse(await fetchText(CASK_API));
  const match = matcher(casks, overrides);
  const intelKey = newestIntelKey(casks);

  const apps = [];
  const skipped = [];
  // Apps curated out of the catalog by hand; they never reach the page.
  const recategorized = JSON.parse(await readFile(path("data/category-overrides.json"), "utf8"));
  const excluded = new Set(JSON.parse(await readFile(path("data/exclude.json"), "utf8")));
  for (const app of list.apps) {
    if (excluded.has(app.slug)) continue;
    const cask = match(app);
    if (!cask) { skipped.push(`${app.name}: not in Homebrew Cask`); continue; }
    const r = recipe(cask, intelKey);
    if (r.skip) { skipped.push(`${app.name} (${cask.token}): ${r.skip}`); continue; }
    apps.push({
      id: cask.token,
      brew: cask.token,
      name: app.name,
      description: app.description,
      category: recategorized[app.slug] || app.category,
      homepage: app.homepage || cask.homepage,
      repo: app.repo,
      icon: app.icon || null,
      stars: app.stars || 0,
      version: cask.version.split(",")[0],
      rawVersion: cask.version,
      ...r,
    });
  }
  // Hand-picked apps beyond data/apps.json, pinned to a Homebrew cask token.
  const byToken = new Map(casks.map((c) => [c.token, c]));
  for (const x of JSON.parse(await readFile(path("data/extras.json"), "utf8"))) {
    if (x.github) {
      // Not in Homebrew: take the asset and its SHA-256 straight from the latest GitHub release.
      const { repo, asset, intelAsset, exclude, app, appleSiliconOnly } = x.github;
      const rel = await latestRelease(repo, asset, exclude);
      const a = rel.asset;
      const sha256 = a && (a.sha256 || await sha256Of(a.url));
      if (!sha256) { skipped.push(`${x.name}: no checksum for ${asset} in ${repo} ${rel.tag_name}`); continue; }
      const dl = { url: a.url, sha256 };
      let intel = appleSiliconOnly ? null : dl;
      if (intelAsset) {
        const ia = (await latestRelease(repo, intelAsset)).asset;
        intel = ia?.sha256 ? { url: ia.url, sha256: ia.sha256 } : null;
      }
      const { github: _, ...meta } = x;
      apps.push({ stars: 0, ...meta, version: rel.tag_name.replace(/^\D*(?=\d)/, ""), rawVersion: rel.tag_name, kind: x.github.kind || "app", src: app, dest: app, arm: dl, intel, minMacos: x.minMacos || null, userAgent: null, referer: null });
      continue;
    }
    if (x.resolver) {
      // One entry becomes one app per version: the first keeps the entry's id, the rest are its other versions.
      const { resolver: _, ...meta } = x;
      (await RESOLVERS[x.resolver]()).forEach((r, i) => {
        const v = i ? { id: `${x.id}-${r.suffix}`, variantOf: x.id, groupName: undefined } : { id: x.id };
        apps.push({ stars: 0, repo: null, icon: null, ...meta, ...v, name: `${x.groupName} ${r.label}`, label: r.label, version: r.version, rawVersion: r.version, kind: "pkg", src: r.src, dest: r.src, arm: r.arm, intel: r.intel, minMacos: x.minMacos || null, userAgent: null, referer: null });
      });
      continue;
    }
    if (x.direct) {
      // Not in Homebrew and no release page: a fixed download link from the publisher's site, hashed here.
      const { url, intelUrl, app, version } = x.direct;
      // These links are fixed addresses whose file can change ("latest"), so hash them fresh every time.
      const fresh = async (u) => { const sum = await sha256Download(u); hashCache.set(u, sum); return sum; };
      const dl = { url, sha256: await fresh(url) };
      const intel = intelUrl ? { url: intelUrl, sha256: await fresh(intelUrl) } : x.direct.universal ? dl : null;
      const { direct: _, ...meta } = x;
      apps.push({ stars: 0, repo: null, icon: null, ...meta, version, rawVersion: version, kind: "app", src: app, dest: app, arm: dl, intel, minMacos: x.minMacos || null, userAgent: null, referer: null });
      continue;
    }
    const cask = byToken.get(x.cask);
    const r = cask && recipe(cask, intelKey);
    if (!r || r.skip) { skipped.push(`${x.name} (${x.cask}): ${r?.skip || "cask not found"}`); continue; }
    const { cask: _, ...meta } = x;
    apps.push({ stars: 0, icon: null, repo: null, homepage: cask.homepage, ...meta, id: cask.token, brew: cask.token, version: cask.version.split(",")[0], rawVersion: cask.version, ...r });
  }
  // Built-in installs (Xcode and its command-line tools): no download, the installer has a handler per id.
  for (const x of JSON.parse(await readFile(path("data/builtins.json"), "utf8"))) {
    apps.push({ stars: 0, repo: null, dest: "-", ...x, kind: "builtin", version: "latest", rawVersion: "latest", arm: null, intel: null, minMacos: null, userAgent: null, referer: null });
  }
  const seen = new Set();
  const unique = apps.filter((a) => !seen.has(a.id) && seen.add(a.id)).sort((a, b) => b.stars - a.stars);
  // Versions: an app with a `groupName` is one card with a version dropdown; the other versions point at it with
  // `variantOf` and stay out of the list (they are still installable by id). The card lists them in `variants`.
  const leaders = new Map(unique.filter((a) => a.groupName).map((a) => [a.id, { a, variants: [{ id: a.id, label: a.label }] }]));
  for (const a of apps) {
    if (!a.variantOf) continue;
    const l = leaders.get(a.variantOf);
    if (l && unique.includes(a)) l.variants.push({ id: a.id, label: a.label });
    else delete a.variantOf;
  }
  for (const { a, variants } of leaders.values()) if (variants.length > 1) a.variants = variants; else delete a.groupName;
  // Chip support. arch: "arm" = Apple Silicon only, "both" = runs on Intel and Apple Silicon, "intel" = an Intel
  // build that Apple Silicon runs through Rosetta. data/arch.json (npm run arch) holds the real Mach-O result for
  // zip downloads shared by both chips; Homebrew can't tell a universal build from an arm64-only one.
  let archData = {};
  try { archData = JSON.parse(await readFile(path("data/arch.json"), "utf8")); } catch {}
  for (const a of unique) {
    if (a.kind === "builtin") continue;
    const seen = archData[a.id]?.archs;
    const sameBuild = a.intel && a.arm?.url === a.intel.url;
    if (!a.intel) a.arch = "arm";
    else if (!sameBuild) a.arch = "both";
    else if (seen && archData[a.id].version === a.version) {
      if (!seen.includes("x86_64")) { a.arch = "arm"; a.intel = null; }       // the shared zip only has an arm64 binary
      else if (!seen.includes("arm64")) a.arch = "intel";
      else a.arch = "both";
      a.archChecked = true;
    } else a.arch = "both";
  }

  // Permalinks: each app gets a permanent slot in data/stable-ids.json (append-only, never reordered or reused), so a
  // link made today still restores the same apps after the catalog grows or loses entries.
  let order = [];
  try { order = JSON.parse(await readFile(path("data/stable-ids.json"), "utf8")); } catch {}
  const slotted = new Set(order);
  for (const a of unique) if (!slotted.has(a.id)) { order.push(a.id); slotted.add(a.id); }
  await writeFile(path("data/stable-ids.json"), JSON.stringify(order) + "\n");

  // Icons and screenshots scraped by `npm run media` (hotlinks); the GitHub avatar stays the fallback icon.
  let media = {};
  try { media = JSON.parse(await readFile(path("data/media.json"), "utf8")); } catch {}
  for (const a of unique) {
    const m = media[a.id];
    if (m?.icon) { if (a.icon && a.icon !== m.icon) a.iconAlt = a.icon; a.icon = m.icon; }
    a.screenshots = m?.screenshots || [];
  }
  // Families: sets of apps from one publisher, shown together in the app modal (data/families.json).
  const familyDefs = JSON.parse(await readFile(path("data/families.json"), "utf8"));
  const ids = new Set(unique.map((a) => a.id));
  const families = Object.entries(familyDefs)
    .map(([slug, f]) => ({ slug, name: f.name, icon: f.icon || null, description: f.description, members: f.members.filter((id) => ids.has(id)) }))
    .filter((f) => f.members.length > 1);
  for (const f of families) for (const a of unique) if (f.members.includes(a.id)) { a.family = f.slug; if (f.icon) a.familyIcon = f.icon; }
  // Categories data/apps.json doesn't have, placed after the one named in `after`.
  for (const { after, ...cat } of JSON.parse(await readFile(path("data/extra-categories.json"), "utf8"))) {
    const at = list.categories.findIndex((c) => c.slug === after);
    list.categories.splice(at < 0 ? list.categories.length : at + 1, 0, cat);
  }
  // Dependencies (data/requires.json): picking an app that needs another one brings the other along.
  const requiresDefs = JSON.parse(await readFile(path("data/requires.json"), "utf8"));
  for (const a of unique) {
    const r = (requiresDefs[a.id] || []).filter((id) => ids.has(id));
    if (r.length) a.requires = r;
  }
  // Profiles: curated starter packs ("Developer", "Designer" ...) whose apps get a Recommended badge.
  const profileDefs = JSON.parse(await readFile(path("data/profiles.json"), "utf8"));
  // A pack is either a flat list (`members`) or parts to choose from (`slots`): "one" = pick one, "any" = pick any,
  // "all" = always included. `defaults` are what "Add" takes when you haven't chosen; an "all" part takes everything.
  const profiles = Object.entries(profileDefs).map(([slug, p]) => {
    const slots = p.slots?.map((s) => {
      const apps = s.apps.filter((id) => ids.has(id));
      return { name: s.name, pick: s.pick, apps, defaults: s.pick === "all" ? apps : (s.defaults || []).filter((id) => apps.includes(id)) };
    }).filter((s) => s.apps.length);
    const members = slots ? [...new Set(slots.flatMap((s) => s.apps))] : p.members.filter((id) => ids.has(id));
    return { slug, name: p.name, description: p.description, members, ...(slots ? { slots } : {}) };
  });
  // Secondary categories: an app can also be listed under other categories (data/also-in.json).
  const alsoDefs = JSON.parse(await readFile(path("data/also-in.json"), "utf8"));
  const known = new Set([...list.categories.map((c) => c.slug)]);
  for (const a of unique) {
    const extra = (alsoDefs[a.id] || []).filter((slug) => known.has(slug) && slug !== a.category);
    if (extra.length) a.also = extra;
  }
  const used = new Set(unique.flatMap((a) => [a.category, ...(a.also || [])]));
  const categories = list.categories.filter((c) => used.has(c.slug)).map(({ slug, name, description }) => ({ slug, name, description }));

  // Groups (data/groups.json): the two-level navigation. A group holds categories; a category that no group lists
  // is gathered into "More" so it never disappears from the page.
  const catSlugs = new Set(categories.map((c) => c.slug));
  const groupDefs = JSON.parse(await readFile(path("data/groups.json"), "utf8"));
  const groups = groupDefs
    .map((g) => ({ ...g, categories: g.categories.filter((c) => catSlugs.has(c.slug)) }))
    .filter((g) => g.categories.length);
  const placed = new Set(groups.flatMap((g) => g.categories.map((c) => c.slug)));
  const strays = categories.filter((c) => !placed.has(c.slug));
  if (strays.length) {
    console.warn(`groups: ${strays.map((c) => c.slug).join(", ")} are in no group (data/groups.json); listed under "More"`);
    groups.push({ slug: "more", name: "More", icon: "layers", categories: strays.map((c) => ({ slug: c.slug })) });
  }

  await mkdir(path("public"), { recursive: true });
  const generated = new Date().toISOString();
  await writeFile(path("public/catalog.json"), JSON.stringify({ generated, order, categories, groups, families, profiles, apps: unique }));

  // id kind src dest version min_macos url_arm sha_arm url_intel sha_intel user_agent referer name bin
  const rows = unique.map((a) => [
    a.id, a.kind, a.src, a.dest, a.version, a.minMacos,
    a.arm?.url, a.arm?.sha256, a.intel?.url, a.intel?.sha256,
    a.userAgent, a.referer, a.name, a.bin,
  ].map(tsvField).join("\t"));
  await writeFile(path("public/catalog.tsv"), `# Getem.sh catalog ${generated}\n${rows.join("\n")}\n`);

  const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
  let installer = await readFile(path("src/install.sh"), "utf8");
  if (siteUrl) installer = installer.replaceAll("__SITE_URL__", siteUrl);
  await writeFile(path("public/install.sh"), installer, { mode: 0o755 });

  // Cache busting: GitHub Pages lets browsers keep files for 10 minutes, so a fresh page could otherwise run with
  // the previous script. The page's links to its script and stylesheet (and the script's import of the icons)
  // carry a fingerprint of the file's content, which changes only when the file does.
  const fingerprint = (text) => createHash("sha256").update(text).digest("hex").slice(0, 10);
  let appJs = await readFile(path("public/app.js"), "utf8");
  const iconsJs = await readFile(path("public/icons.js"), "utf8");
  appJs = appJs.replace(/from "\.\/icons\.js(\?v=[0-9a-f]+)?"/, `from "./icons.js?v=${fingerprint(iconsJs)}"`);
  await writeFile(path("public/app.js"), appJs);
  const styleCss = await readFile(path("public/style.css"), "utf8");
  const page = (await readFile(path("public/index.html"), "utf8"))
    .replace(/href="style\.css(\?v=[0-9a-f]+)?"/, `href="style.css?v=${fingerprint(styleCss)}"`)
    .replace(/src="app\.js(\?v=[0-9a-f]+)?"/, `src="app.js?v=${fingerprint(appJs)}"`);
  await writeFile(path("public/index.html"), page);

  await writeFile(path("data/hashes.json"), JSON.stringify(Object.fromEntries(hashCache), null, 1) + "\n");
  await writeFile(path("data/skipped.txt"), skipped.sort().join("\n") + "\n");
  console.log(`catalog: ${unique.length} installable apps, ${skipped.length} skipped (see data/skipped.txt)`);
  if (!siteUrl) console.log("install.sh: SITE_URL not set; the dev server fills it in per request");
}

main().catch((err) => { console.error(err); process.exit(1); });
