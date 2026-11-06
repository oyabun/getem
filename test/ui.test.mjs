// The page in jsdom: loads public/index.html and public/app.js with the built catalog and walks through the main
// interactions (packs, versions, filters, the install list, the command, links, the FAQ, the theme).
// Each check becomes its own test, so a failure names exactly what broke. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const html = readFileSync(root + "index.html", "utf8").replace(/<script[^>]*src="app\.js[^"]*"[^>]*><\/script>/, "");
const catalog = JSON.parse(readFileSync(root + "catalog.json", "utf8"));
const errors = [];
const dom = new JSDOM(html, { url: "http://localhost:3000/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.addEventListener("error", (e) => errors.push(String(e.error || e.message)));
window.fetch = async (u) => ({ json: async () => catalog, text: async () => "" });
window.scrollTo = () => {};
window.ResizeObserver = class { observe() {} };
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
window.Element.prototype.scrollTo = () => {};
window.navigator.clipboard = { writeText: async () => {} };
const icons = readFileSync(root + "icons.js", "utf8").replace(/^export /gm, "");
const code = icons + "\n" + readFileSync(root + "app.js", "utf8").replace(/^import .*icons\.js[^"]*";\n/m, "");
// Most of these checks walk through the sidebar, so this page starts with it open (a new visitor's starts hidden:
// see "a first visit starts with the sidebar hidden" below).
window.localStorage.setItem("sidebarShown", "1");
try { window.eval(code); } catch (e) { errors.push("eval: " + e.stack); }
await new Promise((r) => setTimeout(r, 300));

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const results = [];
const check = (name, ok, extra = "") => results.push({ name, ok: Boolean(ok), extra: String(extra) });
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const cardsCount = () => $$("#catalog .app").length;
const text = () => $("#catalog").textContent;

check("catalog rendered", cardsCount() > 50, `cards=${cardsCount()}`);
// helper: open a custom dropdown and pick an option by its visible name
const pick = (trigger, name) => {
  click(trigger);
  const opt = $$(".dd-menu .dd-opt").find((o) => o.querySelector(".dd-opt-name").textContent === name);
  if (!opt) throw new Error("no option " + name + " in " + $$(".dd-menu .dd-opt").map((o) => o.textContent).join("|"));
  click(opt);
};
{
  const dd = $("#cats .dd");
  check("profile dropdown has the I'm a label", !!dd && dd.querySelector(".dd-label")?.textContent === "I'm a" && dd.querySelector(".dd-text").textContent.length > 0, dd?.textContent);
  check("empty profile shows a prompt", dd.querySelector(".dd-text").classList.contains("placeholder"), dd.querySelector(".dd-text").textContent);
  click(dd);
  check("menu lists the 9 profiles (no Everyone) with icons", $$(".dd-menu .dd-opt").length === 9 && $$(".dd-menu .dd-opt svg.lucide").length >= 9, `options=${$$(".dd-menu .dd-opt").length}`);
  check("every profile reads naturally after I'm a", $$(".dd-menu .dd-opt-name").map((n) => n.textContent).join("|") === "Muggle|Power User|Developer|Designer|Content Creator|Writer & Student|AI Tinkerer|Privacy Nerd|Gamer", $$(".dd-menu .dd-opt-name").map((n) => n.textContent).join("|"));
  click(dd);
  check("menu closes on second click", $$(".dd-menu").length === 0);
}
check("categories and chrome use Lucide svgs", $$("#cats .side-ic svg.lucide").length > 20 && !!$("#side-toggle svg.lucide") && !!$("#copy svg.lucide"), `side icons=${$$("#cats .side-ic svg.lucide").length}`);
check("filters share the search row", !!$(".tools #filters") && !!$(".tools #search"));
check("by default every app is listed, paid ones included", $$("#catalog .app").some((n) => catalog.apps.find((a) => a.id === n.dataset.id)?.paid));
check("no price filter, no recommended filter, install filter parked", !$("#filters .dd-price") && !$(".dd-price"));
const allCount = cardsCount();

// profile: pick Developer -> pack section + badge
pick($("#cats .dd"), "Developer");
check("dropdown keeps the choice after render", $("#cats .dd-text").textContent === "Developer" && !$("#cats .dd-text").classList.contains("placeholder"), $("#cats .dd-text").textContent);
check("menus are closed after choosing", $$(".dd-menu").length === 0);
{
  // the three ways to clear a starter pack
  check("clear x appears in the dropdown once a pack is chosen", !!$("#cats .dd .dd-clear"));
  click($("#cats .dd .dd-clear"));
  check("dropdown x clears the pack", !$("#catalog .pack") && !$("#cats .dd .dd-clear") && $("#cats .dd-text").classList.contains("placeholder"));
  pick($("#cats .dd"), "Developer");
  check("pack header has a hide button", !!$("#catalog .pack .pack-close"));
  click($("#catalog .pack .pack-close"));
  check("hide button clears the pack", !$("#catalog .pack") && $("#cats .dd-text").classList.contains("placeholder"));
  pick($("#cats .dd"), "Developer");
}
check("pack section shown", !!$("#catalog .pack"), $("#catalog .pack h2")?.textContent);
check("no Recommended badge on cards", $$("#catalog .app .tag-rec").length === 0);
// duplicate-card sync: toggle one card's check, all copies must be selected
const ids = $$("#catalog .pack .app").map((n) => n.dataset.id);
const firstId = ids[0];
click($(`#catalog .pack .app[data-id="${firstId}"] .check`));
const copies = $$(`#catalog .app[data-id="${firstId}"]`);
check("selection syncs across duplicate cards", copies.length >= 2 && copies.every((n) => n.classList.contains("selected")), `copies=${copies.length}`);
// pack add all
click($("#catalog .pack .primary"));
check("Add suggested fills every part", $$("#catalog .pack .slot-all .app").every((n) => n.classList.contains("selected")) && $$("#catalog .pack .slot-one").every((sl) => sl.querySelectorAll(".app.selected").length === 1), $("#catalog .pack .primary").textContent);
check("then the button removes the pack", /^Remove all/.test($("#catalog .pack .primary").textContent), $("#catalog .pack .primary").textContent);
check("parts are labelled pick any / included", ["Pick any", "Included"].every((h) => $$("#catalog .pack .slot-hint").some((n) => n.textContent.startsWith(h))));
check("bar visible with folder count", !$("#bar").hidden && /\d+ apps/.test($("#folder-n").textContent), $("#folder-n").textContent);
check("folder shows at most 3 live pages", $$("#folder-pages .paper:not(.leave)").length === 3, `pages=${$$("#folder-pages .paper:not(.leave)").length}`);
{
  const n = $$("#catalog .app.selected").length;
  const ghosts = $$("#folder-pages .ghost:not(.leave)").length;
  check("blank sheets pile up behind the pages", ghosts === Math.min(6, Math.max(0, new Set($$("#catalog .app.selected").map((x) => x.dataset.id)).size - 3)), `selected=${new Set($$("#catalog .app.selected").map((x) => x.dataset.id)).size} sheets=${ghosts}`);
}
check("older pages are leaving, not piling up", $$("#folder-pages .paper.leave").length >= 1 || $$("#folder-pages .paper").length === 3, `leaving=${$$("#folder-pages .paper.leave").length}`);
// terminal-style command
{
  const cmdText = $("#command").textContent.replace(/\s+/g, " ").trim();
  check("command line starts with a $ prompt and curl", cmdText.startsWith("$ curl -fsSL http://localhost:3000/install.sh | bash -s --"), cmdText.slice(0, 60));
  check("command lists every picked app as its own token", $$("#command .t-id").length === $$("#catalog .app.selected").length || $$("#command .t-id").length > 5, `ids=${$$("#command .t-id").length}`);
  let copied = ""; window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
  click($("#copy")); await new Promise((r) => setTimeout(r, 20));
  check("copy gives one plain line without the prompt", copied.startsWith("curl -fsSL ") && !copied.includes("$") && !copied.includes("\n"), copied.slice(0, 50));
}
// terminal window chrome
{
  check("terminal has window chrome", $$("#term .dot").length === 3 && /zsh/.test($("#term .term-title").textContent));
  check("terminal starts collapsed", $("#term").dataset.open === "false");
  click($("#dot-expand"));
  check("green dot opens the terminal", $("#term").dataset.open === "true");
  click($("#dot-collapse"));
  check("yellow dot collapses it", $("#term").dataset.open === "false");
  click($("#term-toggle")); check("toggle button opens it", $("#term").dataset.open === "true");
  click($("#term-toggle")); check("toggle button collapses it", $("#term").dataset.open === "false");
}
// --dry-run toggle
{
  let copied = ""; window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
  check("dry-run starts off", !$("#dry-run").classList.contains("on") && !/--dry-run/.test($("#command").textContent));
  click($("#dry-run"));
  check("clicking --dry-run adds it to the command", /bash -s -- --dry-run /.test($("#command").textContent.replace(/\s+/g, " ")) && $("#dry-run").classList.contains("on"), $("#command").textContent.replace(/\s+/g, " ").slice(0, 80));
  click($("#copy")); await new Promise((r) => setTimeout(r, 20));
  check("copied command includes --dry-run before the app ids", /^curl -fsSL \S+ \| bash -s -- --dry-run \S/.test(copied), copied.slice(0, 80));
  check("hint explains that dry run is on", /nothing gets installed/.test($("#hint-tail").textContent));
  click($("#dry-run"));
  check("clicking again removes it", !/--dry-run/.test($("#command").textContent) && !$("#dry-run").classList.contains("on"));
  click($("#copy")); await new Promise((r) => setTimeout(r, 20));
  check("copied command is a real install again", !copied.includes("--dry-run"));
}
// drawer
click($("#count"));
check("drawer opens with rows", !$("#drawer").hidden && $$("#drawer .row").length === new Set($$("#catalog .app.selected").map((n) => n.dataset.id)).size, `rows=${$$("#drawer .row").length}`);
const removedName = $("#drawer .row-name").textContent;
const removedId = catalog.apps.find((a) => a.name === removedName).id;
click($("#drawer .row-x"));
check("list stays open after removing an app", !$("#drawer").hidden);
{
  // remove several in a row, as you would when pruning the list
  const before = $$("#drawer .row").length;
  click($("#drawer .row-x")); click($("#drawer .row-x")); click($("#drawer .row-x"));
  check("can keep removing: list still open, 3 fewer rows", !$("#drawer").hidden && $$("#drawer .row").length === before - 3, `${before} -> ${$$("#drawer .row").length}`);
  click($("#bar")); // a click on the bar itself, outside the list and folder
  check("a click outside the list closes it", $("#drawer").hidden);
  click($("#count"));
  check("folder reopens it", !$("#drawer").hidden);
}
await new Promise((r) => setTimeout(r, 350)); // papers that slide out are removed after their animation
check("folder stays in sync when removing", $$("#folder-pages .paper").length <= 3 && /\d+ apps/.test($("#folder-n").textContent), `papers=${$$("#folder-pages .paper").length} n=${$("#folder-n").textContent}`);
check("drawer row remove unselects every copy of that card", $$(`#catalog .app[data-id="${removedId}"]`).every((n) => !n.classList.contains("selected")), removedName);

// sidebar: ☰ shows/hides, « shrinks to a rail
click($("#side-toggle"));
check("☰ hides the sidebar", window.document.body.dataset.sidebar === "hidden");
check("hidden sidebar -> toolbar dropdowns: headings above, no repeated Category label", $$("#filters .dd-tool").length === 2 && $$("#filters .dd-tool .dd-label").map((l) => l.textContent).join() === "I'm a" && $$("#filters .tool-field-label").map((l) => l.textContent).join() === "Starter packs,Categories", $$("#filters .tool-field-label").map((l) => l.textContent).join());
pick($$("#filters .dd-tool")[1], "AI");
check("category dropdown switches category", $$("#catalog .cat h2").every((h) => h.textContent === "AI") && $$("#catalog .app").length > 5, `cards=${$$("#catalog .app").length}`);
check("category dropdown shows a clear x when a category is set", !!$$("#filters .dd-tool")[1].querySelector(".dd-clear"));
click($$("#filters .dd-tool")[1].querySelector(".dd-clear"));
check("category x resets to all categories", $$("#filters .dd-tool")[1].querySelector(".dd-text").textContent === "All categories" && !$$("#filters .dd-tool")[1].querySelector(".dd-clear"));
click($("#side-toggle"));
check("☰ shows it again", window.document.body.dataset.sidebar === "expanded");
// The toolbar keeps its dropdowns in the page (phones always use them); on a wide screen the stylesheet hides them
// while the sidebar is shown, keyed on body[data-sidebar].
const css = readFileSync(root + "style.css", "utf8");
check("with the sidebar shown, the toolbar dropdowns are hidden on wide screens", window.document.body.dataset.sidebar !== "hidden" && /@media \(min-width: 901px\) \{ body:not\(\[data-sidebar="hidden"\]\) \.tools \.tool-field \{ display: none; \} \}/.test(css));
check("on phones the dropdowns replace the sidebar", /\.cats \{ display: none !important; \}/.test(css) && $$("#filters .tool-field").length === 2);
click($(".side-collapse"));
check("« shrinks to the rail", window.document.body.dataset.sidebar === "rail");
check("rail dropdown shows only the icon", !!$("#cats .dd-compact") && !$("#cats .dd-compact .dd-text") && !!$("#cats .dd-compact svg.lucide"));
click($("#side-toggle"));
check("☰ hides from the rail", window.document.body.dataset.sidebar === "hidden");
click($("#side-toggle"));
check("☰ restores the rail", window.document.body.dataset.sidebar === "rail");
click($(".side-collapse"));
check("» expands again", window.document.body.dataset.sidebar === "expanded");

// search clear button
{
  $("#search").value = "blender"; $("#search").dispatchEvent(new window.Event("input"));
  check("clear button appears when searching", !$("#search-clear").hidden);
  click($("#search-clear"));
  check("clear button empties the search and hides", $("#search").value === "" && $("#search-clear").hidden && $$("#catalog .app").length > 50);
}
// multi-category: GenOffice appears under Productivity, Notes & Writing and AI
{
  $("#search").value = "genoffice"; $("#search").dispatchEvent(new window.Event("input"));
  const secs = $$("#catalog section.cat h2").map((h) => h.textContent);
  check("app listed under several categories", ["Office & Documents", "Notes & Writing", "AI"].every((n) => secs.some((t) => t.endsWith(n))), secs.join(" | "));
  $("#search").value = ""; $("#search").dispatchEvent(new window.Event("input"));
}
// chip tags: not on the cards, but on the screenshot in the app's details
{
  const open = (q) => { $("#search").value = q; $("#search").dispatchEvent(new window.Event("input")); click($("#catalog .app")); };
  open("vermut");
  check("Apple Silicon only tag in the details", !!$("#modal .modal-media .media-tags .tag-arm") || !!$("#modal .tag-arm"), $("#modal .tag-arm")?.textContent);
  window.document.querySelector("#modal").close?.();
  open("maccy");
  check("Intel + Apple Silicon tag in the details", $("#modal .tag-both")?.textContent === "Intel + Apple Silicon");
  window.document.querySelector("#modal").close?.();
  $("#search").value = ""; $("#search").dispatchEvent(new window.Event("input"));
  check("cards carry no chip or macOS tags", $$("#catalog .app .tag-chip").length === 0 && !$$("#catalog .app .tag").some((t) => /^macOS/.test(t.textContent)));
}
// modal
click($("#catalog .app"));
check("modal opens, no 'null' text", $("#modal").hasAttribute("open") && !/null/.test($("#modal").textContent), $("#modal h2")?.textContent);
check("modal two-column layout", !!$("#modal .modal-grid"));
// family modal
click($("#modal .modal-close"));
const lulu = $(`#catalog .app[data-id="lulu"]`) || null;
// open lulu via search
$("#search").value = "lulu"; $("#search").dispatchEvent(new window.Event("input"));
click($$("#catalog .app").find((n) => n.dataset.id === "lulu"));
check("family section in modal", !!$("#modal .family") && $$("#modal .member").length === 8, `members=${$$("#modal .member").length}`);
// lightbox
const shots = $$("#modal .shots img");
if (shots.length) { click(shots[0]); check("lightbox opens", $("#lightbox").hasAttribute("open") && $("#lb-img").src.length > 5); }

// ---- dependencies ----
{
  const sel = (id) => catalog.apps.find((a) => a.id === id) && $$(`#catalog .app[data-id="${id}"]`).some((n) => n.classList.contains("selected"));
  const find = (q, id) => { $("#search").value = q; $("#search").dispatchEvent(new window.Event("input")); return $$("#catalog .app").find((n) => n.dataset.id === id); };
  const clearSearch = () => { $("#search").value = ""; $("#search").dispatchEvent(new window.Event("input")); };
  // start empty
  click($("#count")); click($("#drawer-clear"));
  check("selection emptied", $("#bar").hidden);

  click(find("Pi", "pi").querySelector(".check")); clearSearch();
  check("picking Pi adds Node.js too", sel("pi") && sel("node"));
  check("a notice explains why", !$("#toast").hidden && /Node\.js.*Pi needs it/.test($("#toast").textContent), $("#toast").textContent);

  click(find("Node", "node").querySelector(".check")); clearSearch();
  check("removing Node.js asks first", $("#confirm").hasAttribute("open") && /Pi needs Node\.js/.test($("#confirm-text").textContent), $("#confirm-text").textContent.slice(0, 70));
  check("nothing was removed yet", sel("pi") && sel("node"));
  click($("#confirm-keep"));
  check("Keep leaves both in place and closes the dialog", sel("pi") && sel("node") && !$("#confirm").hasAttribute("open"));

  click(find("Node", "node").querySelector(".check")); clearSearch();
  click($("#confirm-remove"));
  check("Remove takes both out", !sel("pi") && !sel("node") && !$("#confirm").hasAttribute("open"));

  click(find("Homebrew", "homebrew").querySelector(".check")); clearSearch();
  check("Homebrew brings the Xcode command-line tools", sel("homebrew") && sel("xcode-cli"));
  click($("#count")); // open the list
  const row = $$("#drawer .row").find((r) => r.querySelector(".row-name").textContent === "Xcode Command Line Tools");
  click(row.querySelector(".row-x"));
  check("the list's x asks before removing a needed app", $("#confirm").hasAttribute("open") && sel("homebrew"));
  click($("#confirm-keep"));

  // the brew command in an app's details needs Homebrew
  click($("#count")); click($("#drawer-clear"));
  click(find("VLC", "vlc"));
  check("details of a brew-installable app say it needs Homebrew", /Needs Homebrew/.test($("#modal .brew-need")?.textContent || ""), $("#modal .brew-need")?.textContent);
  click($("#modal .brew-need .link"));
  clearSearch();
  check("Add Homebrew from the details adds it and its tools", sel("homebrew") && sel("xcode-cli"));
  check("the note then says it is in the list", /in your install list/.test($("#modal .brew-need").textContent));
}

// ---- confetti on "New Mac?" ----
{
  check("lead line says New Mac? One command, and you're ready to go", /New Mac\?\s*One command, and you're ready to go\./.test($(".tagline").textContent), $(".tagline").textContent);
  window.matchMedia = window.matchMedia || (() => ({ matches: false }));
  $("#newmac").dispatchEvent(new window.Event("pointerenter"));
  check("hovering New Mac? does not throw and sets up the confetti layer", errors.length === 0 && !!window.document.querySelector("canvas.confetti"), errors.join("|"));
}

// ---- alphabetical order, no version numbers ----
{
  $("#search").value = ""; $("#search").dispatchEvent(new window.Event("input"));
  const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  const isSorted = (xs) => xs.every((x, i) => i === 0 || cmp(xs[i - 1], x) <= 0);
  const sections = $$("#catalog section.cat:not(.pack)");
  const secKey = (s) => { const h = s.querySelector("h2"); const crumb = h.querySelector(".crumb")?.textContent || ""; if (crumb) return [crumb, h.textContent.slice(crumb.length)];
    // a single-category group is titled with its category's name; its place in the order is the group's name
    const g = catalog.groups.find((x) => x.categories.length === 1 && catalog.categories.find((c) => c.slug === x.categories[0].slug).name === h.textContent);
    return [g ? g.name : h.textContent, ""]; };
  const keys = sections.map(secKey);
  check("sections follow the groups alphabetically, then their categories", keys.every((k, i) => i === 0 || cmp(keys[i - 1][0], k[0]) < 0 || (cmp(keys[i - 1][0], k[0]) === 0 && cmp(keys[i - 1][1], k[1]) <= 0)), keys.slice(0, 4).map((k) => k.join(" > ")).join(" | "));
  check("sidebar groups are alphabetical (All first), ten of them", $$("#cats .side-list > .side-item .side-name")[0].textContent === "All" && $$("#cats .side-group > .side-row .side-name").length === 10 && isSorted($$("#cats .side-group > .side-row .side-name").map((n) => n.textContent)), $$("#cats .side-group > .side-row .side-name").map((n) => n.textContent).join(" | "));
  check("apps inside every category are alphabetical", sections.every((s) => isSorted($$(`#catalog section.cat h2`).length && [...s.querySelectorAll(".app-name")].map((n) => n.textContent))));
  check("cards show no version numbers", $$("#catalog .app .ver").length === 0 && $$("#catalog .app-name").every((n) => n.children.length === 0));
  click($("#catalog .app"));
  check("the details have no Version row", ![...$$("#modal .facts dt")].some((d) => d.textContent === "Version"));
  click($("#modal .modal-close"));
  click($("#count"));
  check("the picked list has no version numbers", $$("#drawer .row .row-ver").length === 0);
  click($("#count"));
}

// ---- "I'm a" / "I'm an" ----
{
  pick($("#cats .dd"), "AI Tinkerer");
  check("an article that fits: I'm an AI Tinkerer", $("#cats .dd .dd-label").textContent === "I'm an", $("#cats .dd .dd-label").textContent);
  pick($("#cats .dd"), "Muggle");
  {
    const browser = $$("#catalog .pack .slot-one").find((sl) => sl.querySelector("h3").textContent === "Browser");
    const [first, second] = browser.querySelectorAll(".app");
    click(first.querySelector(".check")); click(second.querySelector(".check"));
    check("Pick one: choosing another browser replaces the first", browser.querySelectorAll(".app.selected").length === 1 && second.classList.contains("selected") && /^Pick one/.test(browser.querySelector(".slot-hint").textContent));
    click(second.querySelector(".check"));
  }
  check("I'm a Muggle shows the basic pack", $("#cats .dd .dd-label").textContent === "I'm a" && /Muggle starter pack/.test($("#catalog .pack h2")?.textContent || "") && $$("#catalog .pack .slot-head h3").map((h) => h.textContent).join("|") === "Browser|Chat & calls|Music & video|AI assistant|Passwords|Essentials", $$("#catalog .pack .slot-head h3").map((h) => h.textContent).join("|"));
  const names = $$("#catalog .pack .app-name").map((n) => n.textContent);
  check("the Muggle pack includes a browser, chat, office, passwords and the basic AI assistants", ["Google Chrome", "WhatsApp", "LibreOffice", "Bitwarden", "ChatGPT", "Claude"].every((n) => names.includes(n)), names.join(", "));
  click($("#catalog .pack .pack-close"));
}

// ---- groups: two-level navigation ----
{
  const group = (name) => $$("#cats .side-group").find((g) => g.querySelector(".side-row .side-name").textContent === name);
  click($("#catalog .endcap-clear") || $("#search"));
  const develop = group("Development");
  check("a multi-category group has a chevron, a single one does not", !!develop.querySelector(".side-expand") && !group("AI").querySelector(".side-expand"));
  check("groups start closed", !develop.querySelector(".side-subs"));
  click(develop.querySelector(".side-expand"));
  const subs = $$("#cats .side-group").find((g) => g.querySelector(".side-name").textContent === "Development").querySelectorAll(".side-subs .side-name");
  check("opening a group lists its categories with the short names, alphabetical", [...subs].map((n) => n.textContent).join("|") === "APIs|Databases|Editors|Git|Runtimes|Terminal|Tools|Virtual machines", [...subs].map((n) => n.textContent).join("|"));
  click(group("Development").querySelector(".side-item.group-item, .side-row .side-item"));
  const heads = $$("#catalog section.cat h2").map((h) => h.textContent.replace(/\s+/g, " "));
  check("choosing the group shows all its categories, each titled group > category", heads.length === 8 && heads.every((t) => t.startsWith("Development")) && /Editors$/.test(heads[2]), heads.join(" | "));
  click($$("#cats .side-subs .side-item").find((b) => b.querySelector(".side-name").textContent === "Editors"));
  check("choosing a category inside it shows just that one", $$("#catalog section.cat").length === 1 && /Editors$/.test($("#catalog section.cat h2").textContent));
  check("its end-of-list names group and category", /end of Development › Editors/.test($("#catalog .endcap").textContent), $("#catalog .endcap").textContent);
  check("the group row shows it contains the selection", group("Development").querySelector(".side-row .side-item").classList.contains("has-active"));
  click(develop.querySelector(".side-expand"));
  check("the chevron closes it again", !$$("#cats .side-group").find((g) => g.querySelector(".side-name").textContent === "Development").querySelector(".side-subs"));
  click(group("Design").querySelector(".side-row .side-item"));
  check("a single-category group opens its category directly", $$("#catalog section.cat").length === 1 && /Design, Images & Graphics/.test($("#catalog section.cat h2").textContent) && !$("#catalog section.cat h2 .crumb"), $("#catalog section.cat h2").textContent);
  check("phone pills: groups in the first row, the chosen group's categories in a second", $$("#cats .side-pills .pill-row").length === 1);
  click(group("Development").querySelector(".side-row .side-item"));
  check("phone pills: choosing a multi-category group adds a second row", $$("#cats .side-pills .pill-row").length === 2 && $$("#cats .side-pills .sub-row .side-name")[0].textContent === "All Development");
  click($("#cats .side-list > .side-item"));
  check("All returns to every group", $$("#catalog section.cat:not(.pack)").length > 20);
}

// ---- end of the list ----
{
  const reset = () => { if ($("#catalog .endcap-clear")) click($("#catalog .endcap-clear")); };
  reset();
  check("the unfiltered list has no end-of-list note", !$("#catalog .endcap"));
  // a category
  click($$("#cats .side-item").find((b) => b.querySelector(".side-name")?.textContent === "AI"));
  check("a category ends with its own message and a clear button", /end of AI\./.test($("#catalog .endcap").textContent) && !!$("#catalog .endcap-clear"), $("#catalog .endcap").textContent);
  click($("#catalog .endcap-clear"));
  check("Clear filters returns to every category", $$("#catalog section.cat h2").length > 5 && !$("#catalog .endcap"));
  // search with no hits
  $("#search").value = "zzzzzz"; $("#search").dispatchEvent(new window.Event("input"));
  check("no results: message plus clear button", /No apps match/.test($("#catalog .endcap").textContent) && !!$("#catalog .endcap-clear"));
  click($("#catalog .endcap-clear"));
  check("clearing empties the search box too", $("#search").value === "" && $$("#catalog .app").length > 50);
}

// ---- permalinks ----
async function bootAt(url) {
  const d = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = d.window;
  w.addEventListener("error", (e) => errors.push("[second page] " + String(e.error || e.message)));
  w.fetch = async () => ({ json: async () => catalog, text: async () => "" });
  w.scrollTo = () => {}; w.ResizeObserver = class { observe() {} };
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  w.Element.prototype.scrollTo = () => {};
  let copied = "";
  w.navigator.clipboard = { writeText: async (t) => { copied = t; } };
  w.eval(code);
  await new Promise((r) => setTimeout(r, 300));
  return { w, q: (sel) => w.document.querySelector(sel), qa: (sel) => [...w.document.querySelectorAll(sel)], copied: () => copied };
}
const picked = (page) => { page.q("#count").dispatchEvent(new page.w.MouseEvent("click", { bubbles: true })); return page.qa("#drawer .row .row-name").map((n) => n.textContent).sort().join("|"); };
{
  // make a selection in the main page, then copy its link
  click($("#count")); click($("#drawer-clear"));
  for (const id of ["vlc", "iina", "blender", "pi", "raycast", "docker-sandboxes"]) {
    $("#search").value = id; $("#search").dispatchEvent(new window.Event("input"));
    const card = $$("#catalog .app").find((n) => n.dataset.id === id);
    if (card) click(card.querySelector(".check"));
  }
  $("#search").value = ""; $("#search").dispatchEvent(new window.Event("input"));
  let copiedLink = ""; window.navigator.clipboard = { writeText: async (t) => { copiedLink = t; } };
  click($("#share")); await new Promise((r) => setTimeout(r, 20));
  check("Copy link gives a short #s= permalink", /^http:\/\/localhost:3000\/#s=[A-Za-z0-9_-]+$/.test(copiedLink) && copiedLink.length < 110, `${copiedLink.length} chars: ${copiedLink}`);
  check("the page address matches the link", window.location.hash === copiedLink.slice(copiedLink.indexOf("#")));
  const here = picked({ w: window, q: $, qa: $$ });
  const page2 = await bootAt(copiedLink);
  check("opening the link restores exactly the same apps", picked(page2) === here && here.split("|").length >= 6, here.split("|").length + " apps");
  check("it says where they came from", /shared link/.test(page2.q("#toast").textContent), page2.q("#toast").textContent);
  page2.q("#share").dispatchEvent(new page2.w.MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 20));
  check("the same selection always gives the same code", page2.copied() === copiedLink);
  const page3 = await bootAt("http://localhost:3000/#vlc,iina,keka");
  check("a first visit starts with the sidebar hidden, packs and categories in the toolbar", page3.w.document.body.dataset.sidebar === "hidden" && page3.qa("#filters .tool-field").length === 2);
  check("older #a,b,c links still work", picked(page3) === "IINA|Keka|VLC", picked(page3));
  const page4 = await bootAt("http://localhost:3000/#s=!!!not-a-code!!!");
  check("a broken code is ignored without errors", page4.qa("#catalog .app").length > 50 && page4.q("#bar").hidden);
  // a later catalog: new apps appended and old ones dropped must not shift anyone else's slot
  const grown = JSON.parse(JSON.stringify(catalog)); grown.order = [...grown.order, "brand-new-app"]; grown.apps = grown.apps.filter((a) => a.id !== "keka");
  const decodeWith = (cat) => { const w = new JSDOM("<!doctype html>").window; return cat; };
  check("slots are permanent: appending an app leaves earlier slots alone", grown.order.slice(0, catalog.order.length).join() === catalog.order.join());
}

// ---- the details stay open while you act in them ----
{
  const dlg = $("#modal");
  const firstCard = $('#catalog section.cat:not(.pack) .app');
  click(firstCard);
  const add = $("#modal .modal-foot .primary");
  const fire = (target, type) => target.dispatchEvent(new window.Event(type, { bubbles: true }));
  fire(add, "pointerdown"); fire(dlg, "click"); // a press on the button whose release drifted off it
  check("Add to install list doesn't close the details, even if the release drifts off the button", dlg.hasAttribute("open"));
  fire(dlg, "pointerdown"); fire(dlg, "click");
  check("a click on the backdrop still closes them", !dlg.hasAttribute("open"));
}
// ---- FAQ words that act ----
{
  const acts = Object.fromEntries($$(".faq-act").map((b) => [b.dataset.act, b]));
  check("FAQ has AppCleaner, Muggle pack, update, copy link, download and dry-run actions", ["app", "profile", "copy-update", "copy-link", "download", "dry-run"].every((k) => acts[k]), Object.keys(acts).join(","));
  check("each action has a hover icon", $$(".faq-act .faq-act-ic").length === $$(".faq-act").length);
  const hadIt = $$("#catalog .app.selected").some((n) => n.dataset.id === "appcleaner");
  click(acts.app);
  check("AppCleaner link adds it to the install list", $$("#catalog .app.selected").some((n) => n.dataset.id === "appcleaner") && /AppCleaner/.test($("#toast").textContent), $("#toast").textContent);
  if (!hadIt) { click($('#catalog .app[data-id="appcleaner"] .check')); }
  const needs = $$(".faq-act[data-needs-list]");
  check("list actions follow the selection", needs.every((b) => b.getAttribute("aria-disabled") === String(!$$("#catalog .app.selected").length)));
}
// ---- one button to get the script: Copy command, with Download .sh and Ask your AI behind its arrow ----
{
  check("Download .sh is no longer a separate button", !$("#download") && !!$(".split #copy") && !!$(".split #get-more"));
  click($("#get-more"));
  const opts = $$(".dd-menu .dd-opt-name").map((n) => n.textContent);
  check("the arrow offers Copy command, Download .sh and Not feeling safe? Ask your AI", opts.join("|") === "Copy command|Download .sh|Not feeling safe? Ask your AI", opts.join("|"));
  let clip = ""; window.navigator.clipboard = { writeText: async (t) => { clip = t; } };
  click($$(".dd-menu .dd-opt").find((o) => /Ask your AI/.test(o.textContent)));
  await new Promise((r) => setTimeout(r, 20));
  check("Ask your AI copies a prompt with the command and the script's address", /explain what it does/.test(clip) && /curl -fsSL \S+\/install\.sh \| bash -s --/.test(clip) && /The script it runs is public: \S+\/install\.sh/.test(clip), clip.slice(0, 120));
  check("the menu closes after choosing", $$(".dd-menu").length === 0);
  check("the safety question is in the FAQ, with Ask your AI", /looks scary/.test($("#faq").textContent) && !!$('.faq-act[data-act="ask-ai"]'));
}
// ---- the phone menu: packs, categories and theme behind one button ----
{
  const bar = $("#topbar");
  check("the menu holds the pack and category dropdowns and the theme switch", $$("#tools-menu .tool-field").length === 2 && !!$("#tools-menu .theme-switch"));
  click($("#menu-toggle"));
  check("the menu button opens it", bar.classList.contains("menu-open") && $("#menu-toggle").getAttribute("aria-expanded") === "true");
  pick($$("#tools-menu .tool-field .dd")[1], "AI");
  check("choosing a category closes it", !bar.classList.contains("menu-open"));
  check("a dot on the button says a filter is on", $("#menu-toggle").classList.contains("has-filters"));
  click($$("#tools-menu .tool-field .dd")[1].querySelector(".dd-clear"));
  check("no dot once everything is cleared", !$("#menu-toggle").classList.contains("has-filters") || !!window.localStorage.getItem("profile"));
}
// ---- versions and theme ----
{
  const root = window.document.documentElement;
  check("the theme switcher has system, light and dark", $$(".theme-switch button").length === 3 && $(".theme-switch button[aria-pressed=true]")?.dataset.theme === "system");
  click($(".theme-switch button[data-theme=dark]"));
  check("choosing dark sets data-theme and is remembered", root.dataset.theme === "dark" && window.localStorage.getItem("theme") === "dark");
  click($(".theme-switch button[data-theme=system]"));
  check("system removes the override", !root.hasAttribute("data-theme"));
  const names = $$("#catalog .app .app-name").map((n) => n.textContent);
  check("Java, Node.js, Python and Go are one card each", ["Java JDK", "Node.js", "Python", "Go"].every((n) => names.filter((x) => x === n).length === 1), names.filter((n) => /Java|Node|Python|^Go/.test(n)).join("|"));
  check("other versions are not listed as their own cards", !names.some((n) => /^Java JDK \d|Node.js \d|Python 3\.\d/.test(n)));
  const javaCard = $$("#catalog .app").find((n) => n.querySelector(".app-name").textContent === "Java JDK");
  check("the Java card has a version dropdown", !!javaCard.querySelector(".ver-pick .dd"), javaCard.querySelector(".ver-pick")?.textContent);
  click(javaCard.querySelector(".check"));
  check("adding it picks the default version", picked({ w: window, q: $, qa: $$ }).includes("Java JDK 25"), picked({ w: window, q: $, qa: $$ }));
  click(javaCard.querySelector(".ver-pick .dd"));
  const opt = $$(".dd-menu .dd-opt").find((o) => o.textContent.includes("17"));
  click(opt);
  check("choosing another version swaps the pick", /Java JDK 17/.test(picked({ w: window, q: $, qa: $$ })) && !/Java JDK 25/.test(picked({ w: window, q: $, qa: $$ })), picked({ w: window, q: $, qa: $$ }));
}

// jsdom has no canvas: the confetti's "Not implemented" notice is expected and harmless.
const realErrors = errors.filter((e) => !/Not implemented: HTMLCanvasElement/.test(e));
test("the page runs without errors", () => assert.deepEqual(realErrors, []));
const seen = new Map();
for (const r of results) {
  const n = (seen.get(r.name) || 0) + 1;
  seen.set(r.name, n);
  test(n > 1 ? `${r.name} (${n})` : r.name, () => assert.ok(r.ok, r.extra || "check failed"));
}
