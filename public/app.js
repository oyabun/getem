import { lucide } from "./icons.js?v=b4d60b8c7f";
const $ = (sel) => document.querySelector(sel);
// A link carries the selection as #s=<code> (see encodeSelection) or, in older links, as a plain list #a,b,c.
const rawHash = location.hash.slice(1);
const selected = new Set(rawHash.startsWith("s=") ? [] : rawHash.split(",").filter(Boolean));
let catalog;
// Anonymous usage counts through Umami (see "Do you track me?" in the FAQ). When the script is blocked or still loading,
// the event is simply dropped.
const track = (name, data) => { try { window.umami?.track(name, data); } catch {} };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
// Toolbar filters (remembered between visits).
// The Install (Brew / Download) filter is parked for now: flip this to bring the control back.
const SHOW_INSTALL_FILTER = false;
// Every app is listed; paid ones carry a "paid" tag (there is no price filter).
const filters = { source: SHOW_INSTALL_FILTER ? store.get("source") || "any" : "any" };
// ☰ shows or hides the sidebar; « (inside it) switches between full width and an icon rail.
// The sidebar starts hidden (packs and categories are dropdowns in the toolbar); ☰ opens it, and that is remembered.
let sidebarShown = store.get("sidebarShown") === "1";
let sidebarWide = store.get("sidebarWide") !== "0";
const sidebarMode = () => (!sidebarShown ? "hidden" : sidebarWide ? "expanded" : "rail");
document.body.dataset.sidebar = sidebarMode();

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};

// Fallback tiles get a colour from the app's name, so the grid never looks like a wall of grey.
function tint(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 62%), hsl(${(h + 40) % 360} 70% 48%))`;
}

function icon(app, className = "icon") {
  const letter = el("span", { className: "icon-letter" }, app.name[0]);
  const clip = el("div", { className: "icon-clip" }, letter);
  const box = el("div", { className }, clip);
  box.style.setProperty("--tint", tint(app.name));
  // The scraped icon first, then the GitHub avatar; the coloured letter stays if neither loads.
  const urls = [app.icon, app.iconAlt].filter(Boolean);
  const tryNext = () => {
    clip.querySelector("img")?.remove();
    const url = urls.shift();
    if (!url) { box.classList.remove("loading"); return; }
    const img = el("img", { src: url, alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer" });
    img.onload = () => { box.classList.remove("loading"); box.classList.add("has-img"); };
    img.onerror = tryNext;
    clip.append(img);
  };
  // A shimmer holds the place until the icon arrives; if none loads, the coloured letter takes over.
  if (urls.length) box.classList.add("loading");
  tryNext();
  // Apps in a family carry the family's logo as a small badge on the corner.
  if (app.familyIcon && app.familyIcon !== app.icon && !className.includes("icon-sm2")) {
    const fam = catalog.families?.find((f) => f.slug === app.family);
    const badge = el("img", { className: "icon-badge", src: app.familyIcon, alt: "", title: fam ? `${fam.name} family` : "", loading: "lazy", referrerPolicy: "no-referrer" });
    badge.onerror = () => badge.remove();
    box.append(badge);
  }
  return box;
}

// Which Macs an app runs on. "both" covers a universal build or separate Intel and Apple Silicon downloads.
const CHIP = {
  arm: { label: "Apple Silicon only", hint: () => "Needs an M-series Mac (M1 or later). It won't install on an Intel Mac." },
  both: { label: "Intel + Apple Silicon", hint: (a) => (a.archChecked ? "Universal build, checked in the app itself" : "Runs on Intel and Apple Silicon Macs") },
  intel: { label: "Intel (Rosetta on M1+)", hint: () => "An Intel build. Apple Silicon Macs run it through Rosetta." },
};

function tagsFor(app, v = app) {
  const tags = [];
  if (app.paid) tags.push(el("span", { className: "tag tag-paid", title: "Paid, or free with paid plans" }, "paid"));
  return tags;
}

// Which Macs it runs on, the macOS it needs and whether it asks for a password: shown on the screenshot in the app's details, not on the cards.
function chipTags(v) {
  const tags = [];
  if (v.kind === "pkg") tags.push(el("span", { className: "tag", title: "Installs with a .pkg; asks for your admin password" }, "admin"));
  const chip = CHIP[v.arch];
  if (chip) tags.push(el("span", { className: `tag tag-chip tag-${v.arch}`, title: chip.hint(v) }, chip.label));
  if (v.minMacos) tags.push(el("span", { className: "tag" }, `macOS ${v.minMacos}+`));
  return tags;
}

// Permalink codec. The selection is a bitset over the catalog's permanent slots (catalog.order), trailing zeros
// trimmed, as unpadded base64url. The same selection always gives the same code, and it needs no server.
const b64url = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
};

function encodeSelection() {
  const order = catalog.order || [];
  const bytes = new Uint8Array(Math.ceil(order.length / 8));
  order.forEach((id, i) => { if (selected.has(id)) bytes[i >> 3] |= 1 << (i & 7); });
  let n = bytes.length;
  while (n > 0 && bytes[n - 1] === 0) n--;
  return b64url.enc(bytes.subarray(0, n));
}

function decodeSelection(code) {
  try {
    const bytes = b64url.dec(code);
    return (catalog.order || []).filter((_, i) => (bytes[i >> 3] >> (i & 7)) & 1);
  } catch { return []; }
}

// Dependencies: some picks need another app (Pi needs Node.js, Homebrew needs the Xcode command-line tools).
// Adding one brings what it needs along; removing something that is still needed asks first.
const byId = (id) => catalog.apps.find((a) => a.id === id);
const nameOf = (id) => byId(id)?.name || id;

// Versions: Java, Node.js, Python and Go are one card with a version dropdown. The card's app (the "leader") lists
// its `variants`; each version is a normal app with its own id, so the selection, link and install command stay plain ids.
const variantPick = (() => { try { return JSON.parse(store.get("variants") || "{}"); } catch { return {}; } })();
const groupIds = (id) => {
  const a = byId(id);
  const lead = a?.variantOf ? byId(a.variantOf) : a;
  return lead?.variants ? lead.variants.map((v) => v.id) : [id];
};
// The version a card stands for: the one in your list, else the one you last looked at, else the default.
function currentOf(app) {
  if (!app.variants) return app;
  const ids = app.variants.map((v) => v.id);
  return byId(ids.find((i) => selected.has(i)) || (ids.includes(variantPick[app.id]) ? variantPick[app.id] : app.id)) || app;
}
// Needing "Node.js" is met by any of its versions.
const hasAny = (id) => groupIds(id).some((i) => selected.has(i));
function dependentsOf(id) {
  const group = groupIds(id);
  if (group.some((i) => i !== id && selected.has(i))) return [];
  return catalog.apps.filter((a) => selected.has(a.id) && (a.requires || []).some((r) => group.includes(r)));
}
function pickVersion(app, id) {
  const old = currentOf(app).id;
  variantPick[app.id] = id;
  store.set("variants", JSON.stringify(variantPick));
  if (selected.has(old) && old !== id) { selected.delete(old); selected.add(id); }
  update();
  render();
}

let toastTimer;
function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function ensureDeps() {
  const added = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const a of catalog.apps) {
      if (!selected.has(a.id)) continue;
      for (const r of a.requires || []) {
        if (hasAny(r)) continue;
        const need = currentOf(byId(r) || { id: r });
        selected.add(need.id);
        added.push(`${need.name || r} added: ${a.name} needs it`);
        changed = true;
      }
    }
  }
  if (added.length) toast(added.join(" · "));
}

function askRemove(id, deps) {
  const dlg = $("#confirm");
  const names = deps.map((d) => d.name).join(", ");
  $("#confirm-text").textContent = `${names} ${deps.length > 1 ? "need" : "needs"} ${nameOf(id)}. If you remove it, ${deps.length > 1 ? "they" : names} would fail to install, so ${deps.length > 1 ? "they" : "it"} would be removed too.`;
  $("#confirm-keep").textContent = `Keep ${nameOf(id)}`;
  $("#confirm-remove").textContent = `Remove ${nameOf(id)} and ${deps.length > 1 ? "the apps that need it" : names}`;
  $("#confirm-keep").onclick = () => dlg.close();
  $("#confirm-remove").onclick = () => {
    selected.delete(id);
    for (const d of deps) selected.delete(d.id);
    dlg.close();
    update();
    render();
  };
  dlg.showModal();
}

function removeApp(id) {
  const deps = dependentsOf(id);
  if (!deps.length) { selected.delete(id); update(); return; }
  askRemove(id, deps);
}

function toggle(id) {
  if (selected.has(id)) removeApp(id);
  else { selected.add(id); update(); }
}

// "Version  [ 21 LTS v ]" on a card whose app comes in several versions.
function versionPicker(app) {
  return el("div", { className: "ver-pick" }, dropdown({
    label: "Version", value: currentOf(app).id, className: "dd-ver", onChange: (id) => pickVersion(app, id),
    options: app.variants.map((v) => ({ value: v.id, text: v.label, icon: "tag" })),
  }));
}

function card(app, slot = null) {
  const check = el("button", { type: "button", className: "check", title: "Add to install list" });
  const title = app.groupName || app.name;
  const sync = () => {
    const on = selected.has(currentOf(app).id);
    node.classList.toggle("selected", on);
    check.setAttribute("aria-pressed", on);
    check.setAttribute("aria-label", `${on ? "Remove" : "Add"} ${title}`);
  };
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = currentOf(app).id;
    if (slot?.pick === "one" && !selected.has(id)) {
      for (const other of slot.apps) if (other !== app.id) selected.delete(currentOf(byId(other) || { id: other }).id);
    }
    toggle(id);
    sync();
  });
  const tags = tagsFor(app, currentOf(app));
  const node = el("div", { className: "app", role: "button", tabIndex: 0, title: `About ${title}` },
    icon(app),
    el("div", { className: "app-body" },
      el("div", { className: "app-name" }, title),
      el("div", { className: "app-desc" }, app.description || ""),
      app.variants ? versionPicker(app) : null,
      tags.length ? el("div", { className: "tags" }, ...tags) : null,
    ),
    check,
  );
  node.dataset.id = app.id;
  node.addEventListener("click", () => openModal(app));
  node.addEventListener("keydown", (e) => {
    if (e.target === node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openModal(app); }
  });
  sync();
  return node;
}

const dialog = $("#modal");
const fmtStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// In-page screenshot viewer: arrows or buttons to move, × / Esc / backdrop click to close.
const lightbox = $("#lightbox");
let lbUrls = [], lbIndex = 0, lbAlt = "";

function showShot(i) {
  lbIndex = (i + lbUrls.length) % lbUrls.length;
  const img = lightbox.querySelector("#lb-img");
  img.alt = `${lbAlt} screenshot ${lbIndex + 1} of ${lbUrls.length}`;
  img.src = lbUrls[lbIndex];
  $("#lb-count").textContent = `${lbIndex + 1} / ${lbUrls.length}`;
  const many = lbUrls.length > 1;
  $("#lb-prev").hidden = $("#lb-next").hidden = !many;
  $("#lb-count").hidden = !many;
}

function openLightbox(urls, index, alt) {
  lbUrls = urls;
  lbAlt = alt;
  showShot(index);
  if (!lightbox.open) lightbox.showModal();
}

$("#lb-close").addEventListener("click", () => lightbox.close());
$("#lb-prev").addEventListener("click", () => showShot(lbIndex - 1));
$("#lb-next").addEventListener("click", () => showShot(lbIndex + 1));
let lbPressedOnBackdrop = false;
lightbox.addEventListener("pointerdown", (e) => { lbPressedOnBackdrop = e.target === lightbox; });
lightbox.addEventListener("click", (e) => { if (e.target === lightbox && lbPressedOnBackdrop) lightbox.close(); lbPressedOnBackdrop = false; });
lightbox.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); showShot(lbIndex - 1); }
  if (e.key === "ArrowRight") { e.preventDefault(); showShot(lbIndex + 1); }
});

// Screenshots are hotlinked; one that fails to load removes itself, and the row hides if none are left.
function gallery(app) {
  const shots = app.screenshots || [];
  if (!shots.length) return null;
  const row = el("div", { className: "shots" });
  for (const url of shots) {
    const img = el("img", { src: url, alt: `${app.name} screenshot`, loading: "lazy", referrerPolicy: "no-referrer", className: "loading" });
    img.onload = () => img.classList.replace("loading", "loaded");
    img.onerror = () => { img.remove(); if (!row.children.length) row.hidden = true; };
    img.addEventListener("click", () => {
      const urls = [...row.children].map((i) => i.src);
      openLightbox(urls, urls.indexOf(img.src), app.name);
    });
    row.append(img);
  }
  return row;
}

// Homebrew is optional: only apps with a cask get a brew command. Everything else installs from the
// publisher's own download, which is what the curl command does for every app anyway.
function brewLine(app) {
  if (app.note) return el("p", { className: "brew muted" }, app.note);
  if (!app.brew) return el("p", { className: "brew muted" }, "Not in Homebrew. The install command downloads it straight from the publisher.");
  const cmd = `brew install --cask ${app.brew}`;
  const copy = el("button", { type: "button" }, "Copy");
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(cmd);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  const row = el("div", { className: "brew" }, el("code", {}, cmd), copy);
  if (app.id === "homebrew" || !catalog.apps.some((a) => a.id === "homebrew")) return row;
  // The brew command only works where Homebrew is installed, so offer to add it to the list.
  const add = el("button", { type: "button", className: "link" });
  const sync = () => { const on = selected.has("homebrew"); add.replaceChildren(on ? lucide("check", 13) : "", on ? "Homebrew is in your install list" : "Add Homebrew to install list"); add.disabled = on; };
  add.addEventListener("click", () => { toggle("homebrew"); sync(); render(); });
  sync();
  return el("div", { className: "brew-wrap" }, row, el("p", { className: "brew-need muted" }, "Needs Homebrew installed on your Mac. ", add));
}

// Apps from the same publisher, with one button to install the whole family.
function familySection(app, onChange) {
  const fam = catalog.families?.find((f) => f.slug === app.family);
  if (!fam) return null;
  const members = fam.members.map((id) => catalog.apps.find((a) => a.id === id)).filter(Boolean);
  const all = el("button", { type: "button", className: "primary" });
  const buttons = [];
  const sync = () => {
    const every = members.every((m) => selected.has(m.id));
    all.textContent = every ? `Remove all ${members.length}` : `Install all ${members.length}`;
    for (const [m, btn] of buttons) {
      const on = selected.has(m.id);
      btn.textContent = on ? "✓ Added" : "Add";
      btn.classList.toggle("on", on);
    }
    onChange();
  };
  all.addEventListener("click", () => {
    const every = members.every((m) => selected.has(m.id));
    for (const m of members) every ? selected.delete(m.id) : selected.add(m.id);
    update();
    render();
    sync();
  });
  const rows = members.map((m) => {
    const btn = el("button", { type: "button", className: "mini" });
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(m.id); render(); sync(); });
    buttons.push([m, btn]);
    const row = el("div", { className: `member${m.id === app.id ? " current" : ""}`, role: "button", tabIndex: 0, title: `About ${m.name}` },
      icon(m, "icon icon-sm2"),
      el("div", { className: "member-body" },
        el("div", { className: "member-name" }, m.name),
        el("div", { className: "member-desc" }, m.description || ""),
      ),
      btn,
    );
    row.addEventListener("click", () => openModal(m));
    row.addEventListener("keydown", (e) => {
      if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openModal(m); }
    });
    return row;
  });
  const section = el("section", { className: "family" },
    el("div", { className: "family-head" },
      el("div", {}, el("h3", {}, `The ${fam.name} family`), el("p", { className: "muted" }, fam.description)),
      all,
    ),
    el("div", { className: "members" }, ...rows),
  );
  sync();
  return section;
}

// "★ Recommended for Developer, Designer": which starter packs include this app.
function recBadges(app) {
  const profs = profilesFor(app);
  if (!profs.length) return null;
  return el("div", { className: "rec-line" }, el("span", { className: "tag tag-rec" }, lucide("star", 11), "Recommended"), el("span", { className: "muted" }, `for ${profs.map((p) => p.name).join(", ")}`));
}

function openModal(app) {
  const cat = catalog.categories.find((c) => c.slug === app.category);
  const facts = [
    app.paid && ["Price", "Paid, or free with paid plans"],
    cat && ["Category", catsOf(app).map((slug) => catalog.categories.find((c) => c.slug === slug)?.name).filter(Boolean).join(", ")],
    app.stars > 0 && ["GitHub stars", el("span", { className: "stars" }, lucide("star", 13), fmtStars(app.stars))],
    app.variants && ["Versions", app.variants.map((v) => v.label).join(", ")],
    ["Installer", app.kind === "builtin" ? "Built into the install script" : app.kind === "pkg" ? "Package (.pkg), asks for your admin password" : "Drag-and-drop app, no password needed"],
  ].filter(Boolean);
  const links = [
    app.homepage && el("a", { href: app.homepage, target: "_blank", rel: "noopener noreferrer", className: "ext" }, lucide("globe", 15), "Website", lucide("external-link", 12)),
    app.repo && el("a", { href: `https://github.com/${app.repo}`, target: "_blank", rel: "noopener noreferrer", className: "ext" }, lucide("code-xml", 15), "GitHub", lucide("external-link", 12)),
  ].filter(Boolean);
  const action = el("button", { type: "button", className: "primary" });
  const syncAction = () => (action.textContent = selected.has(currentOf(app).id) ? "Remove from install list" : "Add to install list");
  action.addEventListener("click", () => { toggle(currentOf(app).id); syncAction(); render(); });
  syncAction();
  const close = el("button", { type: "button", className: "modal-close", ariaLabel: "Close" }, lucide("x", 18));
  close.addEventListener("click", () => dialog.close());
  const shots = gallery(app);
  const chips = chipTags(currentOf(app));
  const info = el("div", { className: "modal-info" },
    recBadges(app),
    !shots && chips.length ? el("div", { className: "tags" }, ...chips) : null,
    el("p", { className: "modal-desc" }, app.description || "No description available."),
    el("dl", { className: "facts" }, ...facts.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
    brewLine(app),
    el("div", { className: "modal-foot" }, el("div", { className: "modal-links" }, ...links), action),
  );
  // Screenshots on the left, details on the right; one column when there are no screenshots.
  const body = el("div", { className: `modal-grid${shots ? "" : " no-media"}` }, ...[shots && el("div", { className: "modal-media" }, shots, chips.length ? el("div", { className: "media-tags" }, ...chips) : null), info].filter(Boolean));
  dialog.replaceChildren(...[
    close,
    el("div", { className: "modal-head" },
      icon(app, "icon icon-lg"),
      el("div", {}, el("h2", {}, app.groupName || app.name), el("p", { className: "muted" }, cat ? cat.name : "")),
    ),
    body,
    familySection(app, syncAction),
  ].filter(Boolean));
  dialog.classList.toggle("wide", Boolean(app.family));
  dialog.scrollTop = 0;
  if (!dialog.open) dialog.showModal();
}

// What the sidebar has selected: "all", "group:<slug>" (every category of a group) or one category's slug.
let activeCat = store.get("cat") || "all";
let openGroups = new Set((() => { try { return JSON.parse(store.get("openGroups") || "[]"); } catch { return []; } })());
const saveOpen = () => store.set("openGroups", JSON.stringify([...openGroups]));
let activeProfile = store.get("profile") || "";

const profileOf = (slug) => catalog.profiles?.find((p) => p.slug === slug);
const profilesFor = (app) => (catalog.profiles || []).filter((p) => p.members.includes(app.id));

// Everything is listed alphabetically (case-insensitive; "3D & Printing" before "AI", "AI" before "API Development").
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

// Groups hold categories (data/groups.json). With no groups in the catalog, every category is its own group.
const groupList = () => catalog.groups || catalog.categories.map((c) => ({ slug: c.slug, name: c.name, icon: "box", categories: [{ slug: c.slug }] }));
const catInfo = (slug) => catalog.categories.find((c) => c.slug === slug);
const groupFor = (slug) => groupList().find((g) => g.categories.some((c) => c.slug === slug));
const labelOf = (c) => c.label || catInfo(c.slug)?.name || c.slug;
const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true });
// The category slugs the current selection covers (null = everything).
function activeSlugs() {
  if (activeCat === "all") return null;
  if (activeCat.startsWith("group:")) return new Set(groupList().find((g) => g.slug === activeCat.slice(6))?.categories.map((c) => c.slug) || []);
  return new Set([activeCat]);
}

// An app's primary category first, then any others it is also listed under.
const catsOf = (a) => [a.category, ...(a.also || [])];

function appOk(a, q) {
  if (filters.source === "brew" && !a.brew) return false;
  if (filters.source === "download" && a.brew) return false;
  const versions = (a.variants || []).map((v) => `${v.label} ${v.id}`).join(" ");
  return !q || `${a.name} ${a.description} ${a.id} ${versions}`.toLowerCase().includes(q);
}

function setProfile(slug) {
  setMenu(false);
  activeProfile = slug;
  store.set("profile", activeProfile);
  if (slug) track("pick-pack", { pack: slug });
  if (activeProfile) { activeCat = "all"; store.set("cat", "all"); }
  render();
}

// The starter pack for the chosen profile: its apps, a Recommended badge and one button to add them all.
// The starter pack for the chosen profile. A pack comes in parts: "Pick one" (an editor, a browser), "Pick any"
// (runtimes, chat apps) and "Included" (the basics). One button adds the suggested apps for every part you haven't
// chosen in yet; once each part has something, it removes the pack instead.
let syncPack = null;
const PICK_HINT = { one: "Pick one", any: "Pick any", all: "Included" };
function packSection(q) {
  syncPack = null;
  const prof = profileOf(activeProfile);
  if (!prof) return null;
  const slots = (prof.slots || [{ name: "", pick: "all", apps: prof.members, defaults: prof.members }])
    .map((s) => ({ ...s, shown: s.apps.map(byId).filter((a) => a && appOk(a, q)) }))
    .filter((s) => s.shown.length);
  if (!slots.length) return null;
  const idOf = (id) => currentOf(byId(id) || { id }).id;
  const on = (id) => selected.has(idOf(id));
  const toAdd = () => slots.flatMap((s) => (s.pick === "all" ? s.apps.filter((id) => !on(id)) : s.apps.some(on) ? [] : s.defaults));
  const inPack = () => slots.flatMap((s) => s.apps.filter(on));
  const btn = el("button", { type: "button", className: "primary" });
  syncPack = () => {
    const n = toAdd().length;
    btn.textContent = n ? `Add ${n} suggested` : `Remove all ${inPack().length}`;
  };
  btn.addEventListener("click", () => {
    const add = toAdd();
    track(add.length ? "add-pack" : "remove-pack", { pack: activeProfile, apps: add.length });
    if (add.length) for (const id of add) selected.add(idOf(id));
    else for (const s of slots) for (const id of s.apps) selected.delete(idOf(id));
    update();
    render();
  });
  syncPack();
  // Dismiss the pack from here too, so you don't have to find the dropdown.
  const hide = el("button", { type: "button", className: "pack-close", title: "Hide this starter pack", ariaLabel: "Hide this starter pack" }, lucide("x", 18));
  hide.addEventListener("click", () => setProfile(""));
  const parts = slots.map((s) => {
    // the suggested app leads a "Pick one" part; everything else is alphabetical
    const apps = s.shown.sort((x, y) => (s.pick === "one" ? s.defaults.includes(y.id) - s.defaults.includes(x.id) : 0) || byName(x, y));
    const suggested = s.pick !== "all" && s.defaults.length ? ` · suggested: ${s.defaults.map((id) => byId(id)?.groupName || nameOf(id)).join(", ")}` : "";
    return el("div", { className: `slot slot-${s.pick}` },
      s.name ? el("div", { className: "slot-head" }, el("h3", {}, s.name), el("span", { className: "slot-hint" }, PICK_HINT[s.pick] + suggested)) : null,
      el("div", { className: "grid" }, ...apps.map((a) => card(a, s))),
    );
  });
  return el("section", { className: "cat pack" },
    el("div", { className: "pack-head" },
      el("div", {}, el("h2", { className: "pack-title" }, lucide(PROFILE_ICON[prof.slug] || "user", 22), `${prof.name} starter pack`), el("p", { className: "muted" }, prof.description)),
      el("div", { className: "pack-actions" }, btn, hide),
    ),
    ...parts,
  );
}

function setCat(slug) {
  setMenu(false);
  activeCat = slug;
  store.set("cat", slug);
  // choosing something inside a group, or the group itself, opens that group in the sidebar
  const g = slug.startsWith("group:") ? groupList().find((x) => x.slug === slug.slice(6)) : groupFor(slug);
  if (g && g.categories.length > 1) { openGroups.add(g.slug); saveOpen(); }
  render();
  window.scrollTo({ top: Math.max(0, $("#catalog").getBoundingClientRect().top + scrollY - (($("#topbar").offsetHeight || 0) + 16)), behavior: "smooth" });
}

// Lucide icon for each category and each starter-pack profile.
const CAT_ICON = {
  "menu-bar": "panel-top", "window-management": "app-window", launchers: "rocket", focus: "target", "system-utilities": "wrench", clipboard: "clipboard",
  "notes-writing": "pen-line", office: "file-text", ai: "sparkles", "developer-tools": "hammer", runtimes: "cpu", "code-editors": "file-code",
  terminal: "terminal", git: "git-branch", database: "database", api: "webhook", virtualization: "box", design: "palette", "3d-printing": "printer",
  "screen-capture": "camera", video: "film", audio: "headphones", browsers: "globe", communication: "message-circle", email: "mail",
  reading: "book-open", files: "folder", security: "shield", "remote-desktop": "monitor-smartphone", games: "gamepad-2",
};
const PROFILE_ICON = {
  muggle: "smile", "power-user": "zap", developer: "code-xml", designer: "palette", creator: "clapperboard", writer: "notebook-pen",
  ai: "bot", privacy: "shield-check", gamer: "gamepad-2",
};

// ---- dropdown: a button that opens a menu with icons, descriptions and counts (a native <select> can't show those)
let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", openMenu.outside, true);
  document.removeEventListener("keydown", openMenu.keys, true);
  removeEventListener("resize", closeMenu);
  removeEventListener("scroll", openMenu.scroll, true);
  openMenu = null;
}

function openDropdown(btn, options, value, onChange) {
  closeMenu();
  const menu = el("div", { className: "dd-menu", role: "listbox" });
  for (const o of options) {
    const on = o.value === value;
    const opt = el("button", { type: "button", className: `dd-opt${on ? " selected" : ""}${o.indent ? " sub" : ""}`, role: "option" },
      el("span", { className: "dd-icon" }, lucide(o.icon, 17)),
      el("span", { className: "dd-opt-body" }, el("span", { className: "dd-opt-name" }, o.text), o.hint ? el("span", { className: "dd-opt-hint" }, o.hint) : null),
      o.count != null ? el("span", { className: "dd-count" }, String(o.count)) : null,
      on ? el("span", { className: "dd-check" }, lucide("check", 15)) : null,
    );
    opt.setAttribute("aria-selected", on);
    opt.addEventListener("click", () => { closeMenu(); onChange(o.value); });
    menu.append(opt);
  }
  document.body.append(menu);
  const r = btn.getBoundingClientRect();
  const below = innerHeight - r.bottom - 12, above = r.top - 12;
  const up = below < 280 && above > below;
  const width = Math.max(r.width, 250);
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  menu.style.minWidth = `${width}px`;
  menu.style.maxHeight = `${Math.min(up ? above : below, 440)}px`;
  if (up) menu.style.bottom = `${innerHeight - r.top + 6}px`; else menu.style.top = `${r.bottom + 6}px`;
  btn.setAttribute("aria-expanded", "true");
  const outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) closeMenu(); };
  const keys = (e) => {
    const items = [...menu.querySelectorAll(".dd-opt")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); btn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  };
  const scroll = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", keys, true);
  addEventListener("resize", closeMenu);
  addEventListener("scroll", scroll, true);
  openMenu = { menu, btn, outside, keys, scroll };
  (menu.querySelector(".selected") || menu.querySelector(".dd-opt")).focus();
}

// The small x inside a dropdown that resets it. It sits inside the trigger button, so it is a span with a button role.
function clearButton({ title, onClear }) {
  const x = el("span", { className: "dd-clear", role: "button", tabIndex: 0, title, ariaLabel: title }, lucide("x", 13));
  x.setAttribute("aria-label", title);
  const go = (e) => { e.stopPropagation(); e.preventDefault(); closeMenu(); onClear(); };
  x.addEventListener("click", go);
  x.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") go(e); });
  return x;
}

// A labelled dropdown trigger: "I'm a  [icon] Developer  v". `compact` shows only the icon (the icon rail).
function dropdown({ label, value, options, onChange, compact = false, placeholder = "", className = "", clear = null }) {
  const empty = Boolean(placeholder) && !value;
  const current = options.find((o) => o.value === value) || (empty ? { icon: "user", text: placeholder } : options[0]);
  const btn = el("button", { type: "button", className: `dd${compact ? " dd-compact" : ""} ${className}`.trim(), title: current.hint ? `${label ? label + " " : ""}${current.text}: ${current.hint}` : label || "" },
    label && !compact ? el("span", { className: "dd-label" }, label) : null,
    current.icon ? el("span", { className: "dd-icon" }, lucide(current.icon, 16)) : null,
    compact ? null : el("span", { className: `dd-text${empty ? " placeholder" : ""}` }, empty ? placeholder : current.text),
    compact || !clear ? null : clearButton(clear),
    compact ? null : el("span", { className: "dd-chev" }, lucide("chevron-down", 14)),
  );
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (openMenu?.btn === btn) closeMenu(); else openDropdown(btn, options, value, onChange); });
  return btn;
}

function sideItem({ icon, name, count, active, hint, onClick }) {
  const b = el("button", { type: "button", className: `side-item${active ? " active" : ""}`, ariaPressed: active, title: hint || name },
    el("span", { className: "side-ic" }, lucide(icon, 18)),
    el("span", { className: "side-name" }, name),
    count != null ? el("span", { className: "side-n" }, String(count)) : null,
  );
  b.addEventListener("click", onClick);
  return b;
}

function applySidebar() {
  document.body.dataset.sidebar = sidebarMode();
  renderSideToggle();
  if (catalog) render();
}

function renderSideToggle() {
  const b = $("#side-toggle");
  const hint = sidebarShown ? "Hide the sidebar" : "Show the sidebar";
  b.title = hint;
  b.setAttribute("aria-label", hint);
  b.setAttribute("aria-pressed", sidebarShown);
  b.classList.toggle("on", sidebarShown);
}

// "I'm a Developer", but "I'm an AI Tinkerer".
const iAm = (name) => (/^[aeiou]/i.test(name || "") ? "I'm an" : "I'm a");

// Profile choices for the "I'm a" dropdown.
const profileOptions = () => [
  ...(catalog.profiles || []).map((p) => ({ value: p.slug, text: p.name, icon: PROFILE_ICON[p.slug] || "user", hint: p.description })),
];

// One group in the sidebar: a row (the group, with a chevron when it has several categories) and, when open, its categories.
function groupBlock(g, rail) {
  const multi = g.cats.length > 1;
  const token = multi ? `group:${g.slug}` : g.cats[0].slug;
  const contains = multi && g.cats.some((c) => c.slug === activeCat);
  const open = multi && !rail && openGroups.has(g.slug);
  const main = sideItem({
    icon: g.icon || "box", name: g.name, count: g.count, active: activeCat === token,
    hint: multi ? `${g.name}: ${g.cats.map((c) => c.label).join(", ")}` : `${g.name}: ${catInfo(g.cats[0].slug)?.description || ""}`,
    onClick: () => setCat(token),
  });
  if (contains) main.classList.add("has-active");
  const row = el("div", { className: "side-row" }, main);
  if (multi && !rail) {
    const chev = el("button", { type: "button", className: "side-expand", title: open ? `Collapse ${g.name}` : `Show ${g.name}'s categories`, ariaLabel: `${open ? "Collapse" : "Expand"} ${g.name}` }, lucide("chevron-down", 15));
    chev.setAttribute("aria-expanded", open);
    chev.addEventListener("click", () => {
      openGroups.has(g.slug) ? openGroups.delete(g.slug) : openGroups.add(g.slug);
      saveOpen();
      render();
    });
    row.append(chev);
  }
  const block = el("div", { className: "side-group" }, row);
  if (open) {
    block.append(el("div", { className: "side-subs" }, ...g.cats.map((c) => {
      const b = sideItem({ icon: CAT_ICON[c.slug] || "box", name: c.label, count: c.count, active: activeCat === c.slug, hint: `${g.name} › ${c.label}: ${catInfo(c.slug)?.description || ""}`, onClick: () => setCat(c.slug) });
      b.classList.add("sub");
      return b;
    })));
  }
  return block;
}

// The same navigation as two rows of pills, for phones: the groups, then the categories of the chosen group.
function pillRows(hits, groups) {
  const row1 = el("div", { className: "pill-row" },
    dropdown({ label: iAm(profileOf(activeProfile)?.name), value: activeProfile, options: profileOptions(), placeholder: "pick a role…", onChange: setProfile, clear: activeProfile ? { title: "Clear the starter pack", onClear: () => setProfile("") } : null }),
    sideItem({ icon: "layout-grid", name: "All", count: hits.length, active: activeCat === "all", onClick: () => setCat("all") }),
    ...groups.map((g) => {
      const multi = g.cats.length > 1;
      const token = multi ? `group:${g.slug}` : g.cats[0].slug;
      const b = sideItem({ icon: g.icon || "box", name: g.name, count: g.count, active: activeCat === token || (multi && g.cats.some((c) => c.slug === activeCat)), onClick: () => setCat(token) });
      return b;
    }),
  );
  const cur = groups.find((g) => g.cats.length > 1 && (activeCat === `group:${g.slug}` || g.cats.some((c) => c.slug === activeCat)));
  const rows = [row1];
  if (cur) {
    rows.push(el("div", { className: "pill-row sub-row" },
      sideItem({ icon: "layout-grid", name: `All ${cur.name}`, count: cur.count, active: activeCat === `group:${cur.slug}`, onClick: () => setCat(`group:${cur.slug}`) }),
      ...cur.cats.map((c) => sideItem({ icon: CAT_ICON[c.slug] || "box", name: c.label, count: c.count, active: activeCat === c.slug, onClick: () => setCat(c.slug) })),
    ));
  }
  return el("div", { className: "side-pills" }, ...rows);
}

function renderSidebar(hits, groups) {
  const rail = sidebarMode() === "rail";
  const collapse = el("button", { type: "button", className: "side-collapse", title: rail ? "Expand the sidebar" : "Shrink the sidebar to icons", ariaLabel: "Toggle sidebar width" }, lucide(rail ? "chevrons-right" : "chevrons-left", 16));
  collapse.addEventListener("click", () => { sidebarWide = !sidebarWide; store.set("sidebarWide", sidebarWide ? "1" : "0"); applySidebar(); });
  $("#cats").replaceChildren(
    el("div", { className: "side-head" }, el("span", { className: "side-title" }, "Browse"), collapse),
    el("h3", { className: "side-h" }, "Starter packs"),
    dropdown({ label: iAm(profileOf(activeProfile)?.name), value: activeProfile, options: profileOptions(), placeholder: "pick a role…", compact: rail, onChange: setProfile, clear: activeProfile ? { title: "Clear the starter pack", onClear: () => setProfile("") } : null }),
    el("h3", { className: "side-h" }, "Categories"),
    el("div", { className: "side-list" },
      sideItem({ icon: "layout-grid", name: "All", count: hits.length, active: activeCat === "all", onClick: () => setCat("all") }),
      ...groups.map((g) => groupBlock(g, rail)),
    ),
    pillRows(hits, groups),
  );
}

// Toolbar filters: the starter-pack and category dropdowns (and the parked install filter).
function renderFilters(total, groups) {
  const seg = (key, label, opts) => {
    const group = el("div", { className: "seg", role: "group", ariaLabel: label });
    for (const [value, text, hint] of opts) {
      const b = el("button", { type: "button", className: `seg-b${filters[key] === value ? " active" : ""}`, ariaPressed: filters[key] === value, title: hint }, text);
      b.addEventListener("click", () => { filters[key] = value; store.set(key, value); render(); });
      group.append(b);
    }
    return el("div", { className: "filter" }, el("span", { className: "filter-label" }, label), group);
  };
  // Profile and category dropdowns. They show in the toolbar when the sidebar is hidden, and always on phones and
  // small tablets, where they replace the sidebar (CSS decides which).
  let pickers = [];
  {
    const catOptions = [
      { value: "all", text: "All categories", icon: "layout-grid", count: total },
      ...groups.flatMap((g) => g.cats.length > 1
        ? [
          { value: `group:${g.slug}`, text: g.name, icon: g.icon || "box", count: g.count, hint: `Everything in ${g.name}` },
          ...g.cats.map((c) => ({ value: c.slug, text: c.label, icon: CAT_ICON[c.slug] || "box", count: c.count, indent: true })),
        ]
        : [{ value: g.cats[0].slug, text: g.name, icon: g.icon || "box", count: g.count }]),
    ];
    // Each dropdown sits under a small heading, the same ones the sidebar uses.
    const field = (heading, control) => el("div", { className: "tool-field" }, el("span", { className: "tool-field-label" }, heading), control);
    pickers = [
      field("Starter packs", dropdown({
        label: iAm(profileOf(activeProfile)?.name), value: activeProfile, options: profileOptions(), placeholder: "pick a role…", onChange: setProfile, className: "dd-tool",
        clear: activeProfile ? { title: "Clear the starter pack", onClear: () => setProfile("") } : null,
      })),
      field("Categories", dropdown({
        value: activeCat, options: catOptions, onChange: setCat, className: "dd-tool",
        clear: activeCat !== "all" ? { title: "Show all categories", onClear: () => setCat("all") } : null,
      })),
    ];
  }
  $("#filters").replaceChildren(...[
    ...pickers,
    SHOW_INSTALL_FILTER ? seg("source", "Install", [["any", "Any", "Every app"], ["brew", "Brew", "Apps that also have a Homebrew cask"], ["download", "Download", "Apps with no Homebrew cask: downloaded straight from the publisher or the App Store"]]) : null,
  ].filter(Boolean));
}

// Muggle has a mascot: it slides in from the right edge, tilted, while that profile is chosen.
let mascot = null;
function syncMascot() {
  const on = activeProfile === "muggle";
  if (!mascot) {
    if (!on) return;
    mascot = el("img", { className: "mascot", src: "img/muggle.webp", alt: "", decoding: "async", ariaHidden: "true" });
    document.body.append(mascot);
    void mascot.offsetWidth; // so the first slide-in is a transition from the hidden pose
  }
  mascot.classList.toggle("in", on);
}

function render() {
  syncMascot();
  $("#menu-toggle")?.classList.toggle("has-filters", activeCat !== "all" || Boolean(activeProfile));
  const q = $("#search").value.trim().toLowerCase();
  const hits = catalog.apps.filter((a) => !a.variantOf && appOk(a, q));
  const counts = new Map();
  for (const a of hits) for (const slug of catsOf(a)) counts.set(slug, (counts.get(slug) || 0) + 1);

  // The groups that still have something to show, alphabetical, each with its categories alphabetical by label.
  const groups = groupList().map((g) => {
    const slugs = new Set(g.categories.map((c) => c.slug));
    return {
      ...g,
      count: hits.filter((a) => catsOf(a).some((s) => slugs.has(s))).length,
      cats: g.categories.filter((c) => counts.has(c.slug)).map((c) => ({ ...c, label: labelOf(c), count: counts.get(c.slug) })).sort(byLabel),
    };
  }).filter((g) => g.cats.length).sort(byName);

  // A selection that was remembered but is now empty (or gone) falls back to everything.
  const valid = activeCat === "all" || groups.some((g) => activeCat === `group:${g.slug}` || g.cats.some((c) => c.slug === activeCat));
  if (!valid) activeCat = "all";

  renderSidebar(hits, groups);
  renderFilters(hits.length, groups);

  const want = activeSlugs();
  const pack = activeCat === "all" ? packSection(q) : null;
  const sections = groups.flatMap((g) => g.cats.filter((c) => !want || want.has(c.slug)).map((c) => {
    // inside a group the heading leads with the group, quieter, and clicking it shows the whole group: "Internet › Communication"
    let crumb = null;
    if (g.cats.length > 1) {
      crumb = el("button", { type: "button", className: "crumb", title: `Show all of ${g.name}` }, g.name);
      crumb.addEventListener("click", () => setCat(`group:${g.slug}`));
    }
    const title = crumb
      ? [crumb, el("span", { className: "crumb-sep", ariaHidden: "true" }, lucide("chevron-right", 18)), c.label]
      : [catInfo(c.slug)?.name || c.label];
    return el("section", { className: "cat" },
      el("h2", {}, ...title),
      el("p", { className: "muted" }, catInfo(c.slug)?.description || ""),
      el("div", { className: "grid" }, ...hits.filter((a) => catsOf(a).includes(c.slug)).sort(byName).map(card)),
    );
  }));
  const all = [pack, ...sections].filter(Boolean);
  // The end-of-list note only matters when something is filtered (or nothing matched); the full list just ends.
  $("#catalog").replaceChildren(...all, ...(all.length === 0 || filtersActive() ? [endCap(all.length === 0)] : []));
}

// What "no filters" means: no search, every category and no starter pack.
const filtersActive = () => Boolean($("#search").value.trim()) || activeCat !== "all" || Boolean(activeProfile);

function clearFilters() {
  $("#search").value = "";
  $("#search-clear").hidden = true;
  activeCat = "all"; store.set("cat", "all");
  activeProfile = ""; store.set("profile", "");
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// The last thing on the page: says you are at the end, and gets you back to everything when a filter is on.
function endCap(empty) {
  let cat = null;
  if (activeCat.startsWith("group:")) cat = groupList().find((g) => g.slug === activeCat.slice(6))?.name || null;
  else if (activeCat !== "all") { const g = groupFor(activeCat); cat = g && g.categories.length > 1 ? `${g.name} › ${labelOf(g.categories.find((c) => c.slug === activeCat))}` : catInfo(activeCat)?.name || null; }
  const text = empty ? "No apps match these filters." : cat ? `You've reached the end of ${cat}.` : "You've reached the end of the list.";
  const clear = filtersActive() ? el("button", { type: "button", className: "endcap-clear" }, lucide("funnel-x", 16), "Clear filters") : null;
  clear?.addEventListener("click", clearFilters);
  return el("div", { className: "endcap" }, el("span", { className: "endcap-flag" }, lucide("flag", 16)), el("p", {}, text), clear);
}

const ids = () => catalog.apps.filter((a) => selected.has(a.id)).map((a) => a.id);
// --dry-run: the install script only prints what it would do. Off by default and never remembered, so a pasted
// command installs unless you chose otherwise this time.
let dryRun = false;
// Where this site lives, folder included (GitHub Pages serves it under /<repo>/), without a trailing slash.
const SITE = new URL(".", location.href).href.replace(/\/$/, "");
const command = () => `curl -fsSL ${SITE}/install.sh | bash -s -- ${dryRun ? "--dry-run " : ""}${ids().join(" ")}`;

function syncDry() {
  const b = $("#dry-run");
  b.classList.toggle("on", dryRun);
  b.setAttribute("aria-pressed", dryRun);
  b.title = dryRun ? "Remove --dry-run from the command" : "Add --dry-run to the command";
  $("#hint-lead").textContent = dryRun ? "Paste into Terminal." : "Paste into Terminal. Click";
  $("#hint-tail").textContent = dryRun ? "is on: nothing gets installed, it only shows what would happen. Click to remove it." : "to add it and preview first.";
}

let pickedOpen = false;

// The bottom-bar folder: one page per picked app sticks out of a frosted-glass folder (the newest on top).
const paperEls = new Map();
const ghostEls = [];
const MAX_GHOSTS = 6;   // blank sheets in the pile; each pick past the visible pages adds one
const MAX_PAPERS = 3;   // the folder shows the newest few picks; older pages slide out as new ones arrive
function renderFolder() {
  const order = [...selected];
  const n = order.length;
  $("#count").setAttribute("aria-label", `${n} app${n === 1 ? "" : "s"} picked. ${pickedOpen ? "Hide" : "Show"} the list`);
  $("#folder-n").textContent = `${n} app${n === 1 ? "" : "s"}`;
  const cats = new Set(catalog.apps.filter((a) => selected.has(a.id)).map((a) => a.category)).size;
  $("#folder-sub").textContent = `${cats} categor${cats === 1 ? "y" : "ies"} · ${pickedOpen ? "list open" : "tap to review"}`;
  $("#folder-pill").textContent = pickedOpen ? "Hide" : "Review";
  // Every pick beyond the visible pages becomes a blank sheet in the pile behind them (up to MAX_GHOSTS).
  const ghosts = Math.min(MAX_GHOSTS, Math.max(0, n - MAX_PAPERS));
  const pile = $("#folder-pages");
  while (ghostEls.length > ghosts) { const g = ghostEls.pop(); g.classList.add("leave"); setTimeout(() => g.remove(), 260); }
  while (ghostEls.length < ghosts) {
    const g = el("span", { className: "ghost enter" });
    ghostEls.push(g);
    pile.prepend(g);
    setTimeout(() => g.classList.remove("enter"), 400);
  }
  ghostEls.forEach((g, i) => {
    const side = i % 2 ? 1 : -1;
    g.style.setProperty("--gx", `${side * (4 + i * 3.4)}px`);
    g.style.setProperty("--gy", `${-i * 1.6}px`);
    g.style.setProperty("--gr", `${side * (2.5 + i * 1.2)}deg`);
    g.style.zIndex = "0";
  });
  const show = order.slice(-MAX_PAPERS);
  const pages = $("#folder-pages");
  for (const [id, node] of paperEls) {
    if (show.includes(id)) continue;
    paperEls.delete(id);
    node.classList.add("leave");           // slide out, then remove
    setTimeout(() => node.remove(), 280);
  }
  show.forEach((id, i) => {
    let node = paperEls.get(id);
    if (!node) {
      const app = catalog.apps.find((a) => a.id === id);
      node = el("span", { className: "paper enter" }, icon({ ...app, familyIcon: null }, "icon icon-paper"), el("span", { className: "paper-name" }, app.name), el("span", { className: "paper-line" }), el("span", { className: "paper-line short" }));
      paperEls.set(id, node);
      pages.append(node);
      setTimeout(() => node.classList.remove("enter"), 450);
    }
    // Fan the pages so the whole spread fits inside the folder: spacing shrinks as pages are added.
    const off = i - (show.length - 1) / 2;
    const gaps = Math.max(1, show.length - 1);
    const half = gaps / 2;
    const tilt = Math.min(7, 20 / gaps);
    const rot = (half * tilt * Math.PI) / 180;
    // Use all the width the folder has: whatever room is left after the page itself and its tilt is shared out
    // between the pages, so two apps sit almost side by side and more apps overlap only as much as they must.
    const room = 90 - 42 * Math.cos(rot) - 126 * Math.sin(rot);
    const step = Math.min(88, Math.max(6, room / half));
    node.style.setProperty("--rot", `${off * tilt}deg`);
    node.style.setProperty("--x", `${off * step}px`);
    node.style.setProperty("--sag", `${Math.abs(off) * 1.5}px`);
    node.style.zIndex = String(i + 1);
  });
}

// Your list, as a slide-in drawer on the right: compact rows grouped by category, scrolls on its own,
// and leaves the bottom bar slim however many apps you pick.
function renderPicked() {
  const drawer = $("#drawer");
  const picks = catalog.apps.filter((a) => selected.has(a.id));
  if (!picks.length) pickedOpen = false;
  drawer.hidden = !pickedOpen;
  $("#count").setAttribute("aria-expanded", pickedOpen);
  if (!pickedOpen) return;
  $("#drawer-title").textContent = `Install list · ${picks.length} app${picks.length === 1 ? "" : "s"}`;
  const cats = catalog.categories.filter((c) => picks.some((a) => a.category === c.slug));
  const rows = [];
  for (const cat of cats) {
    rows.push(el("h3", { className: "drawer-cat" }, cat.name));
    for (const app of picks.filter((a) => a.category === cat.slug)) {
      const remove = el("button", { type: "button", className: "row-x", ariaLabel: `Remove ${app.name}`, title: `Remove ${app.name}` }, lucide("trash-2", 15));
      remove.addEventListener("click", () => removeApp(app.id));
      const open = el("button", { type: "button", className: "row-name", title: `About ${app.name}` }, app.name);
      open.addEventListener("click", () => openModal(app));
      rows.push(el("div", { className: "row" }, icon(app, "icon icon-sm"), open, remove));
    }
  }
  $("#drawer-list").replaceChildren(...rows);
}

// The same app can be on the page twice (starter pack and its category), so every copy of a card
// follows the selection, not just the one that was clicked.
function syncCards() {
  for (const node of document.querySelectorAll("#catalog .app")) {
    const lead = byId(node.dataset.id);
    const on = selected.has(currentOf(lead || { id: node.dataset.id }).id);
    const app = lead;
    node.classList.toggle("selected", on);
    const check = node.querySelector(".check");
    check.setAttribute("aria-pressed", on);
    if (app) check.setAttribute("aria-label", `${on ? "Remove" : "Add"} ${app.name}`);
  }
}

// The install command, drawn like a terminal line: prompt, coloured parts, a blinking cursor, wrapping instead of scrolling.
// Copying uses command(), so the clipboard still gets one plain line.
function renderCommand() {
  const t = (cls, text) => el("span", { className: `t-${cls}` }, text);
  const parts = [
    t("prompt", "$ "), t("cmd", "curl"), " ", t("flag", "-fsSL"), " ", t("url", `${SITE}/install.sh`), " ",
    t("pipe", "|"), " ", t("cmd", "bash"), " ", t("flag", "-s"), " ", t("flag", "--"),
    ...(dryRun ? [" ", t("dry", "--dry-run")] : []),
    ...ids().flatMap((id) => [" ", t("id", id)]),
    " ", t("caret", " "),
  ];
  $("#command").replaceChildren(...parts.map((p) => (typeof p === "string" ? document.createTextNode(p) : p)));
  syncTerm();
}

// The terminal shows two lines by default and opens up to a taller scrolling view on request.
let termOpen = store.get("termOpen") === "1";
function setTerm(open) {
  termOpen = open;
  store.set("termOpen", open ? "1" : "0");
  syncTerm();
}
function syncTerm() {
  const term = $("#term"), cmd = $("#command"), toggle = $("#term-toggle");
  term.dataset.open = termOpen;
  toggle.setAttribute("aria-expanded", termOpen);
  toggle.replaceChildren(termOpen ? "Collapse" : "Show all", lucide(termOpen ? "chevron-up" : "chevron-down", 12));
  // Only offer the toggle when the command is longer than the collapsed two lines.
  requestAnimationFrame(() => {
    const cs = getComputedStyle(cmd);
    const lineH = parseFloat(cs.lineHeight) || 22;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const longer = cmd.scrollHeight > lineH * 2 + pad + 2;
    toggle.hidden = !longer;
    term.classList.toggle("more", longer && !termOpen);
  });
}

function update() {
  ensureDeps();
  syncCards();
  syncPack?.();
  syncFaqActions();
  const list = ids();
  history.replaceState(null, "", list.length ? `#s=${encodeSelection()}` : location.pathname);
  $("#bar").hidden = !list.length;
  renderFolder();
  renderPicked();
  renderCommand();
  $("#admin-hint").hidden = !catalog.apps.some((a) => selected.has(a.id) && a.kind === "pkg");
}

// A downloaded script carries its own catalog rows, so it works offline from this site.
async function downloadScript() {
  track("download-script", { apps: selected.size });
  const [script, tsv] = await Promise.all(["install.sh", "catalog.tsv"].map((f) => fetch(f).then((r) => r.text())));
  const wanted = new Set(ids());
  const rows = tsv.split("\n").filter((line) => wanted.has(line.split("\t")[0]));
  const embed = [
    "EMBEDDED=1",
    `DEFAULT_APPS="${ids().join(" ")}"`,
    "embedded_catalog() {",
    "cat <<'__GETEM_CATALOG__'",
    ...rows,
    "__GETEM_CATALOG__",
    "}",
  ].join("\n");
  const out = script
    .replace(/(# @@EMBED_START@@[^\n]*\n)[\s\S]*?(\n# @@EMBED_END@@)/, (_, start, end) => `${start}${embed}${end}`)
    .replaceAll("__SITE_URL__", SITE);
  const url = URL.createObjectURL(new Blob([out], { type: "text/x-shellscript" }));
  el("a", { href: url, download: "getem-install.sh" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyLink() {
  track("copy-link", { apps: selected.size });
  await navigator.clipboard.writeText(`${location.origin}${location.pathname}#s=${encodeSelection()}`);
  const btn = $("#share");
  const label = btn.querySelector(".btn-label");
  btn.querySelector(".lucide").replaceWith(lucide("check", 16));
  label.textContent = "Link copied";
  setTimeout(() => {
    btn.querySelector(".lucide").replaceWith(lucide("link", 16));
    label.textContent = "Copy link";
  }, 1500);
}

// A prompt for an AI assistant to look the command over before you run it.
const aiPrompt = () => [
  "I'm setting up my Mac with getem.sh. Before I run this command in Terminal, can you explain what it does and tell me if anything in it looks unsafe?",
  "",
  selected.size ? command() : `curl -fsSL ${SITE}/install.sh | bash -s -- --dry-run`,
  "",
  `The script it runs is public: ${SITE}/install.sh`,
].join("\n");
async function copyAiPrompt() {
  track("ask-ai", { apps: selected.size });
  await navigator.clipboard.writeText(aiPrompt());
  toast("Copied! Paste it into ChatGPT, Claude or any AI assistant and let it check the command for you");
}

async function copyCommand() {
  track("copy-command", { apps: selected.size, dryRun });
  await navigator.clipboard.writeText(command());
  const btn = $("#copy");
  const label = btn.querySelector(".btn-label");
  btn.classList.add("done");
  btn.querySelector(".lucide").replaceWith(lucide("check", 16));
  label.textContent = "Copied";
  setTimeout(() => {
    btn.classList.remove("done");
    btn.querySelector(".lucide").replaceWith(lucide("copy", 16));
    label.replaceChildren("Copy", el("span", { className: "long" }, " command"));
  }, 1500);
}

// Confetti: a short burst from an element, drawn on one transparent canvas laid over the page. It is skipped for people
// who ask for reduced motion, and the canvas is only created the first time it is needed.
const CONFETTI_COLORS = ["#8b7bf2", "#6a59e0", "#ffd23f", "#ff9f0a", "#f472b6", "#34d399", "#60a5fa"];
const confettiState = { canvas: null, ctx: null, parts: [], running: false, last: 0 };

function confetti(from, count = 54) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const st = confettiState;
  if (!st.canvas) {
    st.canvas = el("canvas", { className: "confetti", ariaHidden: "true" });
    st.ctx = st.canvas.getContext?.("2d");
    document.body.append(st.canvas);
    const fit = () => {
      const dpr = devicePixelRatio || 1;
      st.canvas.width = innerWidth * dpr;
      st.canvas.height = innerHeight * dpr;
      st.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    addEventListener("resize", fit);
  }
  if (!st.ctx) return;
  const r = from.getBoundingClientRect();
  for (let i = 0; i < count; i++) {
    st.parts.push({
      x: r.left + Math.random() * r.width, y: r.top + r.height * 0.55,
      vx: (Math.random() - 0.5) * 9, vy: -(5 + Math.random() * 9),
      w: 6 + Math.random() * 7, h: 4 + Math.random() * 6, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.5,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0], age: 0, life: 70 + Math.random() * 55,
    });
  }
  if (st.running) return;
  st.running = true;
  const tick = () => {
    const { ctx, canvas, parts } = st;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.age++;
      p.vy += 0.34; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, p.age - p.life * 0.6) / (p.life * 0.4));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    st.parts = parts.filter((p) => p.age < p.life);
    if (st.parts.length) requestAnimationFrame(tick);
    else { st.running = false; ctx.clearRect(0, 0, canvas.width, canvas.height); }
  };
  requestAnimationFrame(tick);
}

// Icons for the buttons that are written in the HTML.
function decorate() {
  $("#side-toggle").replaceChildren(lucide("panel-left", 18));
  $("#search-clear").replaceChildren(lucide("x", 13));
  $(".search-wrap").prepend(el("span", { className: "search-icon" }, lucide("search", 16)));
  $("#drawer-close").replaceChildren(lucide("x", 18));
  $("#lb-close").replaceChildren(lucide("x", 22));
  $("#lb-prev").replaceChildren(lucide("chevron-left", 26));
  $("#lb-next").replaceChildren(lucide("chevron-right", 26));
  $("#copy").prepend(lucide("copy", 16));
  $("#get-more").replaceChildren(lucide("chevron-down", 16));
  $("#share").prepend(lucide("link", 16));
  // On a phone the bar is one compact row: the folder becomes a pill, the other buttons keep only their icons,
  // and the terminal opens on demand. These names keep the icon-only buttons readable to screen readers.
  $("#share").setAttribute("aria-label", "Copy link");
  $("#count").prepend(el("span", { className: "folder-mini-ic" }, lucide("folder-open", 18)));
  $("#term-show").replaceChildren(lucide("terminal", 18));
  $("#term-show").addEventListener("click", () => {
    const bar = $("#bar");
    const open = bar.dataset.term !== "1";
    bar.dataset.term = open ? "1" : "0";
    $("#term-show").setAttribute("aria-expanded", open);
    $("#term-show").classList.toggle("on", open);
  });
}

// The toolbar sticks to the top once the header has scrolled away. A one-pixel sentinel just above it tells us when:
// while it is out of view the bar is "stuck", which shows the small logo and drops the headings above the dropdowns.
function watchTopbar() {
  const bar = $("#topbar");
  $("#mini-brand").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  if (!("IntersectionObserver" in window)) return;
  new IntersectionObserver(([e]) => {
    const stuck = !e.isIntersecting && e.boundingClientRect.top < 0;
    if (bar.classList.contains("stuck") === stuck) return;
    // Whatever changes the bar's height when it sticks is paid back as margin, so the page below doesn't jump.
    const before = bar.offsetHeight;
    bar.classList.toggle("stuck", stuck);
    bar.style.marginBottom = stuck ? `${Math.max(0, before - bar.offsetHeight)}px` : "";
    $("#mini-brand").tabIndex = stuck ? 0 : -1;
    document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
  }).observe($("#topbar-sentinel"));
}

// Theme: follows the system until the switcher picks light or dark (remembered). index.html sets data-theme before
// the first paint; this keeps it, the favicons and the small logo in step, and builds the switcher.
const THEMES = [["system", "monitor", "Match my system"], ["light", "sun", "Light"], ["dark", "moon", "Dark"]];
let theme = ["light", "dark"].includes(store.get("theme")) ? store.get("theme") : "system";
function applyTheme() {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme"); else root.dataset.theme = theme;
  // The small logo's <picture> chooses by media query, so point it at the chosen theme too.
  const media = (original, dark) => (theme === "system" ? original : (theme === "dark") === dark ? "all" : "not all");
  for (const n of document.querySelectorAll("source[data-dark]")) {
    n.setAttribute("media", media(n.dataset.media, n.dataset.dark === "1"));
  }
  for (const b of document.querySelectorAll(".theme-switch button")) b.setAttribute("aria-pressed", b.dataset.theme === theme);
}
// The tab icon sits in the browser's own tab bar, which follows the system, not this page: white on a dark system,
// black on a light one. Some browsers ignore `media` on icon links, so swap in one set and follow system changes.
const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)") || { matches: false };
function syncFavicon() {
  const tone = systemDark.matches ? "white" : "black";
  for (const l of document.querySelectorAll("link[rel=icon]")) l.remove();
  for (const [size, file] of [[16, `favicon-${tone}-micro-16.png`], [32, `favicon-${tone}-micro-32.png`], [48, `favicon-${tone}-48.png`]]) {
    const l = document.createElement("link");
    l.rel = "icon";
    l.type = "image/png";
    l.setAttribute("sizes", `${size}x${size}`);
    l.href = `img/${file}`;
    document.head.append(l);
  }
}

function setupTheme() {
  syncFavicon();
  systemDark.addEventListener?.("change", syncFavicon);
  for (const n of document.querySelectorAll("source[media]")) {
    const m = n.getAttribute("media");
    if (!m.includes("prefers-color-scheme")) continue;
    n.dataset.media = m;
    n.dataset.dark = m.includes("dark") ? "1" : "0";
  }
  const box = el("div", { className: "theme-switch", role: "group", ariaLabel: "Theme" },
    ...THEMES.map(([value, icon, label]) => {
      const b = el("button", { type: "button", title: label, ariaLabel: label }, lucide(icon, 16), el("span", { className: "theme-label" }, label.replace("Match my system", "System")));
      b.setAttribute("aria-label", label);
      b.dataset.theme = value;
      b.addEventListener("click", () => { theme = value; store.set("theme", value === "system" ? "" : value); applyTheme(); });
      return b;
    }));
  $("#tools-menu").append(box);
  applyTheme();
}

// Words in the FAQ that do what they say: open an app, show a pack, copy a command, toggle --dry-run.
// The ones that need a list ("Copy link", "--dry-run", "Download .sh") only work once you've picked something.
const FAQ_ICON = { "ask-ai": "bot", app: "square-plus", "dry-run": "flask-conical", "copy-update": "copy", "copy-link": "link", download: "download", profile: "funnel" };
function setupFaqActions() {
  for (const b of document.querySelectorAll(".faq-act")) {
    const act = b.dataset.act;
    const app = act === "app" ? byId(b.dataset.app) : null;
    if (act === "app" && !app) { b.replaceWith(document.createTextNode(b.textContent)); continue; }
    b.append(el("span", { className: "faq-act-ic", ariaHidden: "true" }, lucide(FAQ_ICON[act], 14)));
    b.title = {
      app: `Add ${app?.name} to your install list`, profile: "Show this starter pack", "copy-update": "Copy this command",
      "copy-link": "Copy a link to your install list", "ask-ai": "Copy your command with a prompt for an AI assistant", download: "Download your install script", "dry-run": "Toggle --dry-run on your command",
    }[act];
    b.addEventListener("click", async () => {
      if (b.getAttribute("aria-disabled") === "true") { toast("Pick some apps first"); return; }
      if (act === "app") {
        if (selected.has(app.id)) toast(`${app.name} is already in your install list`);
        else { selected.add(app.id); update(); toast(`${app.name} added to your install list`); }
      }
      else if (act === "profile") { setProfile(b.dataset.profile); window.scrollTo({ top: Math.max(0, $("#catalog").getBoundingClientRect().top + scrollY - (($("#topbar").offsetHeight || 0) + 16)), behavior: "smooth" }); }
      else if (act === "copy-update") { await navigator.clipboard.writeText($("#update-cmd").textContent); toast("Update command copied"); }
      else if (act === "copy-link") { await copyLink(); toast("Link to your install list copied"); }
      else if (act === "download") downloadScript();
      else if (act === "ask-ai") copyAiPrompt();
      else if (act === "dry-run") { dryRun = !dryRun; syncDry(); renderCommand(); toast(dryRun ? "--dry-run is on: the command only shows what it would do" : "--dry-run is off"); }
    });
  }
  syncFaqActions();
}
function syncFaqActions() {
  const has = selected.size > 0;
  for (const b of document.querySelectorAll(".faq-act[data-needs-list]")) b.setAttribute("aria-disabled", String(!has));
}

// Phones and small tablets: the starter pack, category and theme controls live behind one menu button.
// Choosing a pack or a category closes it; so do Escape and a tap outside the top bar.
function setMenu(open) {
  $("#topbar").classList.toggle("menu-open", open);
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
  $("#menu-toggle").replaceChildren(lucide(open ? "x" : "menu", 20));
}
function setupMenu() {
  setMenu(false);
  $("#menu-toggle").addEventListener("click", () => setMenu(!$("#topbar").classList.contains("menu-open")));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !openMenu && $("#topbar").classList.contains("menu-open")) setMenu(false); });
  document.addEventListener("pointerdown", (e) => {
    if (!$("#topbar").classList.contains("menu-open")) return;
    const path = e.composedPath();
    if (!path.includes($("#topbar")) && !path.some((n) => n.classList?.contains("dd-menu"))) setMenu(false);
  });
}

async function main() {
  decorate();
  setupMenu();
  setupTheme();
  watchTopbar();
  // Hovering "New Mac?" (or tapping it on a touch screen) throws a little confetti from the words.
  let lastBurst = 0;
  const burst = () => { if (Date.now() - lastBurst > 700) { lastBurst = Date.now(); confetti($("#newmac")); } };
  $("#newmac").addEventListener("pointerenter", burst);
  $("#newmac").addEventListener("click", burst);
  catalog = await fetch("catalog.json").then((r) => r.json());
  const known = new Set(catalog.apps.map((a) => a.id));
  const fromLink = rawHash.startsWith("s=") ? decodeSelection(rawHash.slice(2)) : [];
  for (const id of fromLink) selected.add(id);
  for (const id of selected) if (!known.has(id)) selected.delete(id);
  if (selected.size) toast(`Loaded ${selected.size} app${selected.size === 1 ? "" : "s"} from a shared link`);
  $("#side-toggle").addEventListener("click", () => { sidebarShown = !sidebarShown; store.set("sidebarShown", sidebarShown ? "1" : "0"); applySidebar(); });
  renderSideToggle();
  $("#update-cmd").textContent = `curl -fsSL ${SITE}/install.sh | bash -s -- --update`;
  $("#generated").textContent = `Catalog updated ${new Date(catalog.generated).toLocaleDateString()}.`;
  // One answer open at a time (also for browsers without <details name>).
  for (const d of document.querySelectorAll(".faq-item")) {
    d.addEventListener("toggle", () => { if (d.open) for (const o of document.querySelectorAll(".faq-item[open]")) if (o !== d) o.open = false; });
  }
  setupFaqActions();
  $("#search").addEventListener("input", () => { $("#search-clear").hidden = !$("#search").value; render(); });
  $("#search-clear").addEventListener("click", () => { $("#search").value = ""; $("#search-clear").hidden = true; $("#search").focus(); render(); });
  $("#search").addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#search").value) { e.preventDefault(); $("#search-clear").click(); } });
  $("#copy").addEventListener("click", copyCommand);
  $("#share").addEventListener("click", copyLink);
  $("#term-toggle").addEventListener("click", () => setTerm(!termOpen));
  $("#dry-run").addEventListener("click", () => { dryRun = !dryRun; syncDry(); renderCommand(); });
  syncDry();
  $("#dot-expand").addEventListener("click", () => setTerm(true));
  $("#dot-collapse").addEventListener("click", () => setTerm(false));
  addEventListener("resize", syncTerm);
  $("#count").addEventListener("click", () => { pickedOpen = !pickedOpen; update(); });
  $("#drawer-close").addEventListener("click", () => { pickedOpen = false; update(); });
  $("#drawer-clear").addEventListener("click", () => { selected.clear(); pickedOpen = false; render(); update(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pickedOpen && !document.querySelector("dialog[open]")) { pickedOpen = false; update(); } });
  // A click anywhere outside the list and the folder closes it.
  document.addEventListener("click", (e) => {
    // The click's path is fixed when it starts, so it still counts as "inside" after a row was removed and redrawn.
    const inside = e.composedPath().some((n) => n.id === "drawer" || n.id === "count" || n.tagName === "DIALOG");
    if (!pickedOpen || inside) return;
    pickedOpen = false;
    update();
  });
  // The drawer stops just above the bottom bar, wherever that ends up.
  const measure = () => {
    document.documentElement.style.setProperty("--bar-h", `${$("#bar").offsetHeight}px`);
    document.documentElement.style.setProperty("--topbar-h", `${$("#topbar").offsetHeight}px`);
    document.documentElement.style.setProperty("--cats-h", `${$("#cats").offsetHeight}px`);
    // The folder pokes up out of the bar; the list opens above the folder's top edge.
    const top = $("#count").getBoundingClientRect().top;
    if (top > 0) document.documentElement.style.setProperty("--pop-bottom", `${Math.round(innerHeight - top + 14)}px`);
  };
  new ResizeObserver(measure).observe($("#bar"));
  new ResizeObserver(measure).observe($("#topbar"), { box: "border-box" });
  new ResizeObserver(measure).observe($("#cats"));   // padding changes count too
  new ResizeObserver(measure).observe($("#count"));
  addEventListener("resize", measure);
  // One button for getting the script: Copy command, with the other ways behind its arrow.
  $("#get-more").addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = $("#get-more");
    if (openMenu?.btn === btn) { closeMenu(); return; }
    openDropdown(btn, [
      { value: "copy", text: "Copy command", icon: "copy", hint: "Paste it into Terminal" },
      { value: "download", text: "Download .sh", icon: "download", hint: "A script with your apps built in; works offline" },
      { value: "ask-ai", text: "Not feeling safe? Ask your AI", icon: "bot", hint: "Copies the command with a prompt: paste it into ChatGPT, Claude or any assistant and let it check it for you" },
    ], null, (v) => { if (v === "copy") copyCommand(); else if (v === "download") downloadScript(); else copyAiPrompt(); });
  });
  // Close on a backdrop click only when the press also started on the backdrop. A click whose press and release land
  // on different elements is delivered to their common parent (the dialog itself), so without this a press on
  // "Add to install list" that ends a little off the button would close the details.
  let pressedOnBackdrop = false;
  dialog.addEventListener("pointerdown", (e) => { pressedOnBackdrop = e.target === dialog; });
  dialog.addEventListener("click", (e) => { if (e.target === dialog && pressedOnBackdrop) dialog.close(); pressedOnBackdrop = false; });
  render();
  update();
}

main().catch((err) => {
  $("#catalog").replaceChildren(el("p", {}, `Could not load the app list (${err.message}). Please reload the page.`));
});
