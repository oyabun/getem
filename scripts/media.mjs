// Finds a real app icon and up to three screenshots for every app in the catalog, as hotlinks.
//   sources, in order: GitHub README images, the app's homepage (og:image, touch icons),
//   then the Mac App Store (iTunes lookup) for whatever is still missing.
// Every URL is checked to be a reachable image before it is kept. Results are cached in
// data/media.json, which build.mjs merges into the catalog.   Usage: npm run media [-- --refresh] [id ...]
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const path = (p) => new URL(p, root);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAX_SHOTS = 3;
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i;

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const only = new Set(args.filter((a) => !a.startsWith("--")));

const get = (url, init = {}) =>
  fetch(url, { redirect: "follow", signal: AbortSignal.timeout(12000), ...init, headers: { "user-agent": UA, ...init.headers } });

async function text(url, limit = 1_500_000) {
  try {
    const res = await get(url, { headers: { accept: "text/html,text/markdown,*/*" } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return { body: buf.subarray(0, limit).toString("utf8"), url: res.url };
  } catch { return null; }
}

// A URL counts as an image if it answers 200/206 with an image type and isn't tiny.
async function checkImage(url, minBytes = 0) {
  try {
    const res = await get(url, { headers: { range: "bytes=0-1023", accept: "image/*,*/*" } });
    res.body?.cancel().catch(() => {});
    if (!(res.status === 200 || res.status === 206)) return false;
    const type = res.headers.get("content-type") || "";
    if (!(type.startsWith("image/") || (type.includes("octet-stream") && IMG_EXT.test(url)))) return false;
    const total = Number((res.headers.get("content-range") || "").split("/")[1] || res.headers.get("content-length") || 0);
    return !minBytes || !total || total >= minBytes;
  } catch { return false; }
}

const resolve = (src, base) => { try { return new URL(src.trim().replace(/&amp;/g, "&"), base).href; } catch { return null; } };

const JUNK = /shields\.io|badge|travis-ci|codecov|circleci|coveralls|opencollective|buymeacoffee|ko-fi|patreon|sponsor|star-history|contrib\.rocks|githubusercontent\.com\/u\/|avatars\.|gravatar|\/workflows\/|img\.youtube|youtube\.com|spacer|pixel|1x1|emoji|twemoji|donate|paypal|stackoverflow|discord(app)?\.com\/api|crowdin|weblate|transifex|\.svg(\?|$)|favicon|sprite/i;
const OTHER_OS = /windows|win(10|11)|android|iphone|ipad|ios|linux|ubuntu|gnome|kde-?plasma|mobile|phone|flatpak|snap/i;
const ICON_PATH = /app-icon|hicolor|\/icons?\/|appicon|icon-\d+|-icon\./i;
const SHOT_HINT = /screenshot|screen-shot|screencap|preview|demo|ui[-_.]|interface|window|showcase|capture|main|hero|app[-_.]/i;
const ICON_HINT = /logo|icon|badge|banner|header|wordmark|appstore|download/i;

function score(url, alt = "") {
  const s = `${url} ${alt}`;
  let n = 0;
  if (SHOT_HINT.test(s)) n += 3;
  if (/screenshot/i.test(s)) n += 3;
  if (ICON_HINT.test(url)) n -= 3;
  if (/user-attachments|user-images|assets\//i.test(url)) n += 1;
  if (/\.(png|jpe?g|webp)(\?|$)/i.test(url)) n += 1;
  if (/\.gif(\?|$)/i.test(url)) n += 0.5;
  return n;
}

// Image candidates from README markdown/HTML, resolved against the repo's raw file URLs.
function readmeImages(md, repo) {
  const raw = `https://raw.githubusercontent.com/${repo}/HEAD/`;
  const out = [];
  const push = (src, alt = "") => {
    if (!src || src.startsWith("data:")) return;
    let url = /^https?:/.test(src) ? src : resolve(src.replace(/^\.?\//, ""), raw);
    if (!url) return;
    url = url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+?)(\?raw=true)?$/, "https://raw.githubusercontent.com/$1/$2");
    if (JUNK.test(url) && !/user-attachments|user-images/.test(url)) return;
    if (OTHER_OS.test(`${url} ${alt}`) || ICON_PATH.test(url)) return;
    if (!IMG_EXT.test(url) && !/user-attachments|user-images|githubusercontent\.com|assets\//.test(url)) return;
    out.push({ url, alt });
  };
  for (const m of md.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) push(m[2], m[1]);
  for (const m of md.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] || "";
    push(src, alt);
  }
  for (const m of md.matchAll(/<source\b[^>]*\bsrcset\s*=\s*["']([^"'\s,]+)/gi)) push(m[1]);
  return out;
}

// og:image / twitter:image, touch icons and screenshot-looking <img>s from a homepage.
function pageMedia(html, base) {
  const meta = (name) => {
    const m = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i").exec(html)?.[0];
    const c = m && /content=["']([^"']+)["']/i.exec(m)?.[1];
    return c && resolve(c, base);
  };
  const icons = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() || "";
    if (!/icon/.test(rel)) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
    const size = Number(/sizes=["'](\d+)x/i.exec(tag)?.[1] || (rel.includes("apple") ? 180 : 0));
    const url = href && resolve(href, base);
    // Favicons are too small to use as an app icon; only touch icons and 96px+ icons count.
    if (url && size >= 96 && !/\.svg(\?|$)/i.test(url)) icons.push({ url, size, apple: rel.includes("apple") });
  }
  icons.sort((a, b) => b.size - a.size || Number(b.apple) - Number(a.apple));
  const imgs = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] || "";
    const url = src && resolve(src, base);
    if (url && IMG_EXT.test(url) && !JUNK.test(url) && !OTHER_OS.test(`${url} ${alt}`) && /screenshot|screen-shot|preview|demo|interface|showcase/i.test(`${url} ${alt}`)) imgs.push({ url, alt });
  }
  return { og: meta("og:image") || meta("twitter:image"), icons, imgs };
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
let lastItunes = 0;
async function itunes(name, site) {
  // Apple allows roughly 20 lookups a minute per address.
  const wait = lastItunes + 3200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastItunes = Date.now();
  try {
    const res = await get(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=macSoftware&limit=8`);
    if (!res.ok) return null;
    // A same-named stranger on the store is common ("Motrix - AI Chat Client"), so the seller must
    // be tied to the app's own website or GitHub owner.
    const label = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").split(".").slice(-2, -1)[0] || ""; } catch { return ""; } };
    const keys = [label(site?.homepage), (site?.repo || "").split("/")[0], norm(name)].map(norm).filter((k) => k.length > 3);
    const hit = (await res.json()).results?.find((r) => {
      if (norm(r.trackName.split(/ [-–:] /)[0]) !== norm(name)) return false;
      const seller = norm(`${r.sellerUrl || ""} ${r.artistName || ""} ${r.sellerName || ""}`);
      return keys.slice(0, 2).some((k) => seller.includes(k));
    });
    return hit ? { icon: hit.artworkUrl512 || hit.artworkUrl100, shots: hit.screenshotUrls || [] } : null;
  } catch { return null; }
}

async function firstValid(cands, n, minBytes) {
  const out = [];
  const seen = new Set();
  for (const c of cands) {
    if (out.length >= n) break;
    const url = typeof c === "string" ? c : c.url;
    if (seen.has(url)) continue;
    seen.add(url);
    if (await checkImage(url, minBytes)) out.push(url);
  }
  return out;
}

async function findMedia(app, override = {}) {
  app = { ...app, ...(override.homepage ? { homepage: override.homepage } : {}) };
  const result = { icon: null, iconSource: null, screenshots: [], sources: [] };
  const shotCands = [];
  const iconCands = [];

  if (app.repo) {
    const readme = await text(`https://raw.githubusercontent.com/${app.repo}/HEAD/README.md`) ||
      await text(`https://raw.githubusercontent.com/${app.repo}/HEAD/readme.md`) ||
      await text(`https://raw.githubusercontent.com/${app.repo}/HEAD/README.rst`);
    if (readme) {
      const imgs = readmeImages(readme.body, app.repo);
      imgs.sort((a, b) => score(b.url, b.alt) - score(a.url, a.alt));
      shotCands.push(...imgs.filter((i) => score(i.url, i.alt) > -1));
      for (const i of imgs) if (/(^|[/_.-])(app-?)?icon[^/]*\.(png|jpe?g)/i.test(i.url)) iconCands.push(i.url);
    }
  }

  let ogShot = null;
  if (app.homepage && !/github\.com/.test(app.homepage)) {
    const page = await text(app.homepage);
    if (page) {
      const m = pageMedia(page.body, page.url);
      shotCands.push(...m.imgs);
      ogShot = m.og;
      iconCands.push(...m.icons.map((i) => i.url));
    }
  }

  result.screenshots = await firstValid(shotCands, MAX_SHOTS, 12000);
  if (result.screenshots.length) result.sources.push("web");
  if (!result.screenshots.length && ogShot && (await checkImage(ogShot, 12000))) {
    result.screenshots = [ogShot];
    result.sources.push("og");
  }
  const homeIcon = (await firstValid(iconCands, 1, 2000))[0];
  if (homeIcon) { result.icon = homeIcon; result.iconSource = "web"; }

  // Mac App Store: real Mac screenshots and icons. These beat scraped web images when they exist.
  const hit = await itunes(app.name, app);
  if (hit) {
    const shots = await firstValid(hit.shots, MAX_SHOTS, 0);
    if (shots.length) { result.screenshots = shots; result.sources = ["appstore"]; }
    if (hit.icon && (await checkImage(hit.icon))) { result.icon = hit.icon; result.iconSource = "appstore"; }
  }
  if (override.icon) { result.icon = override.icon; result.iconSource = "manual"; }
  if (override.noIcon) { result.icon = null; result.iconSource = null; }   // no good icon exists: show the letter tile
  if (override.screenshots?.length) { result.screenshots = override.screenshots; result.sources = ["manual"]; }
  return result;
}


// ---- --deep: a harder second pass for apps that still have no real screenshot ----

const SUBPAGES = ["screenshots", "screenshot", "gallery", "screens", "features", "tour", "media", "press", "download", "about", "overview"];

// Any decent-looking content image on a page, ranked by how screenshot-like it looks.
function looseImages(html, base) {
  const out = [];
  for (const m of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || /\bsrcset\s*=\s*["']([^"'\s,]+)/i.exec(tag)?.[1];
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || "";
    const url = src && resolve(src, base);
    if (!url || !IMG_EXT.test(url) || /\.gif(\?|$)/i.test(url) && false) continue;
    if (JUNK.test(url) || OTHER_OS.test(`${url} ${alt}`) || ICON_HINT.test(url) || ICON_PATH.test(url)) continue;
    out.push({ url, alt });
  }
  return out.sort((a, b) => score(b.url, b.alt) - score(a.url, a.alt));
}

function pageLinks(html, base, home) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)) {
    const url = resolve(m[1], base);
    if (!url || new URL(url).origin !== new URL(home).origin) continue;
    if (/screenshot|gallery|screens|features|tour|showcase|overview/i.test(url)) out.add(url.split("#")[0]);
  }
  return [...out].slice(0, 4);
}

const REPO_SHOT_PATHS = [
  "screenshot.png", "screenshot.jpg", "Screenshot.png", "screenshots/screenshot.png", "screenshots/1.png", "screenshots/main.png",
  "screenshots/screenshot-1.png", "docs/screenshot.png", "docs/screenshots/screenshot.png", "docs/images/screenshot.png",
  "assets/screenshot.png", "assets/screenshots/1.png", "images/screenshot.png", ".github/screenshot.png", ".github/assets/screenshot.png",
  "docs/assets/screenshot.png", "Screenshots/screenshot.png", "Screenshots/1.png", "art/screenshot.png", "preview.png", "demo.png",
];

// Screenshot-named files in a few conventional folders of the repo, read from GitHub's HTML (no API quota).
async function repoFolderShots(repo) {
  const found = [];
  for (const dir of ["screenshots", "Screenshots", "docs/screenshots", "docs/images", "assets", "images", "art", ".github/assets"]) {
    const page = await text(`https://github.com/${repo}/tree/HEAD/${dir}`, 400_000);
    if (!page) continue;
    const names = new Set([...page.body.matchAll(new RegExp(`/blob/[^/"]+/${dir.replace(/[.]/g, "\\.")}/([^"/]+\\.(?:png|jpe?g|webp|gif))"`, "gi"))].map((m) => m[1]));
    for (const n of names) {
      if (OTHER_OS.test(n) || ICON_HINT.test(n)) continue;
      found.push(`https://raw.githubusercontent.com/${repo}/HEAD/${dir}/${n}`);
    }
    if (found.length >= 6) break;
  }
  return found.sort((a, b) => score(b) - score(a));
}

// Wikipedia's infobox screenshot, plus other files on the article named like a screenshot.
async function wikipediaShots(name) {
  const api = (q) => get(`https://en.wikipedia.org/w/api.php?format=json&origin=*&${q}`).then((r) => r.json()).catch(() => null);
  for (const title of [name, `${name} (software)`, `${name} (application)`]) {
    const r = await api(`action=query&redirects=1&prop=pageimages|categories|images&piprop=original&cllimit=50&imlimit=60&titles=${encodeURIComponent(title)}`);
    const page = Object.values(r?.query?.pages || {})[0];
    if (!page || page.missing !== undefined) continue;
    const cats = (page.categories || []).map((c) => c.title).join(" ");
    if (!/software|application|emulator|editor|browser|player|program|tool|utility|manager|client|game/i.test(cats)) continue;
    // Screenshots are often named after the app ("GIMP-3.png") and not "screenshot".
    const token = norm(name);
    const files = (page.images || []).map((i) => i.title).filter((t) =>
      /\.(png|jpe?g|webp)$/i.test(t) && !OTHER_OS.test(t) && !/logo|icon|mascot|wordmark|flag|button|commons|symbol|people/i.test(t) &&
      (/screenshot|screen[-_ ]?shot|interface|ui\b/i.test(t) || norm(t).includes(token)));
    const urls = [];
    if (page.original?.source && !/logo|icon/i.test(page.original.source)) urls.push(page.original.source);
    if (files.length) {
      const info = await api(`action=query&prop=imageinfo&iiprop=url&iiurlwidth=1280&titles=${encodeURIComponent(files.slice(0, 4).join("|"))}`);
      for (const p of Object.values(info?.query?.pages || {})) {
        const ii = p.imageinfo?.[0];
        if (ii) urls.push(ii.thumburl || ii.url);
      }
    }
    if (urls.length) return urls;
  }
  return [];
}

async function deepFind(app, override = {}) {
  const home = override.homepage || app.homepage;
  const cands = [];
  // 1. the site's own subpages (screenshots, gallery, features ...)
  if (home && !/github\.com/.test(home)) {
    const first = await text(home);
    const pages = new Set();
    if (first) {
      cands.push(...looseImages(first.body, first.url));
      for (const l of pageLinks(first.body, first.url, home)) pages.add(l);
    }
    const origin = new URL(first?.url || home).origin;
    for (const sub of SUBPAGES.slice(0, 6)) pages.add(`${origin}/${sub}`);
    for (const url of [...pages].slice(0, 8)) {
      const p = await text(url);
      if (p) cands.push(...looseImages(p.body, p.url));
    }
  }
  // 2. conventional screenshot files and folders in the GitHub repo
  if (app.repo) {
    cands.push(...REPO_SHOT_PATHS.map((p) => `https://raw.githubusercontent.com/${app.repo}/HEAD/${p}`));
    cands.push(...(await repoFolderShots(app.repo)));
  }
  let shots = await firstValid(cands, MAX_SHOTS, 40000);
  // 3. Wikipedia
  if (!shots.length) shots = await firstValid(await wikipediaShots(app.name), MAX_SHOTS, 0);
  return shots;
}

async function pool(items, size, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      if (++done % 10 === 0) console.log(`media: ${done}/${items.length}`);
    }
  }));
}

async function main() {
  const catalog = JSON.parse(await readFile(path("public/catalog.json"), "utf8"));
  let cache = {};
  try { cache = JSON.parse(await readFile(path("data/media.json"), "utf8")); } catch {}
  let overrides = {};
  try { overrides = JSON.parse(await readFile(path("data/media-overrides.json"), "utf8")); } catch {}
  const deep = args.includes("--deep");
  const apps = catalog.apps.filter((a) => {
    if (only.size) return only.has(a.id);
    if (deep) return !cache[a.id]?.screenshots?.length || cache[a.id].sources?.join() === "og";
    return refresh || !cache[a.id];
  });
  console.log(`media: ${apps.length} apps to look up (${catalog.apps.length} total)`);
  // The Mac App Store lookups are throttled, so run few workers; web fetches overlap with the waits.
  await pool(apps, 6, async (app) => {
    if (deep) {
      const entry = cache[app.id] || { icon: null, iconSource: null, screenshots: [], sources: [] };
      const shots = await deepFind(app, overrides[app.id]);
      if (shots.length) { entry.screenshots = shots; entry.sources = ["deep"]; }
      cache[app.id] = entry;
    } else cache[app.id] = await findMedia(app, overrides[app.id]);
    await writeFile(path("data/media.json"), JSON.stringify(cache, null, 1) + "\n");
  });
  const have = catalog.apps.filter((a) => cache[a.id]?.screenshots?.length).length;
  const icons = catalog.apps.filter((a) => cache[a.id]?.icon).length;
  console.log(`media: screenshots for ${have}/${catalog.apps.length} apps, own icon for ${icons}/${catalog.apps.length}`);
  const missing = catalog.apps.filter((a) => !cache[a.id]?.screenshots?.length).map((a) => a.id);
  await writeFile(path("data/media-missing.txt"), missing.join("\n") + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
