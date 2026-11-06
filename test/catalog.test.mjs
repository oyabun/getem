// The built catalog and the data it comes from hang together: every id a pack, dependency, family or version
// list names is a real app, downloads carry checksums, and shared links keep their slots. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const catalog = JSON.parse(read("public/catalog.json"));
const tsv = read("public/catalog.tsv").split("\n").filter((l) => l && !l.startsWith("#"));
const stableIds = JSON.parse(read("data/stable-ids.json"));
const ids = new Set(catalog.apps.map((a) => a.id));
const byId = new Map(catalog.apps.map((a) => [a.id, a]));
const categories = new Set(catalog.categories.map((c) => c.slug));

test("the catalog has a healthy number of apps", () => {
  assert.ok(catalog.apps.length > 200, `${catalog.apps.length} apps`);
});

test("app ids are unique and safe to type in a shell", () => {
  assert.equal(ids.size, catalog.apps.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9@._-]*$/, id);
});

test("every app has a name, a known category and only known secondary categories", () => {
  for (const a of catalog.apps) {
    assert.ok(a.name, a.id);
    assert.ok(categories.has(a.category), `${a.id}: ${a.category}`);
    for (const c of a.also || []) assert.ok(categories.has(c), `${a.id}: also ${c}`);
  }
});

// "no_check" means the publisher serves a changing "latest" file with no fixed checksum (Homebrew's :no_check);
// the installer warns and skips verification for those.
test("every download has a SHA-256 checksum, or is marked as having none", () => {
  const sha = /^([0-9a-f]{64}|no_check)$/;
  for (const a of catalog.apps) {
    if (a.kind === "builtin") continue;
    assert.ok(a.arm?.url, `${a.id}: no download`);
    for (const dl of [a.arm, a.intel].filter(Boolean)) {
      assert.match(dl.url, /^https:\/\//, `${a.id}: ${dl.url}`);
      if (dl.sha256 != null) assert.match(dl.sha256, sha, `${a.id}: ${dl.sha256}`);
    }
  }
});

test("catalog.tsv has one row per app, with the same ids", () => {
  const rows = tsv.map((l) => l.split("\t")[0]);
  assert.deepEqual(new Set(rows), ids);
  assert.equal(rows.length, ids.size);
  for (const l of tsv) assert.equal(l.split("\t").length, 14, l.slice(0, 60));
});

test("starter packs only name real apps, and their parts are well formed", () => {
  for (const p of catalog.profiles) {
    assert.ok(p.members.length, `${p.slug} is empty`);
    for (const id of p.members) assert.ok(ids.has(id), `${p.slug}: ${id}`);
    for (const s of p.slots || []) {
      assert.ok(["one", "any", "all"].includes(s.pick), `${p.slug}/${s.name}: ${s.pick}`);
      for (const id of s.defaults) assert.ok(s.apps.includes(id), `${p.slug}/${s.name}: default ${id} isn't in the part`);
      if (s.pick === "one") assert.ok(s.defaults.length <= 1, `${p.slug}/${s.name}: pick one suggests ${s.defaults.length}`);
      for (const id of s.apps) assert.ok(!byId.get(id)?.variantOf, `${p.slug}/${s.name}: ${id} is a version, name its card instead`);
    }
  }
});

test("versions point at a real card, and each card lists its own versions", () => {
  for (const a of catalog.apps) {
    if (a.variantOf) {
      const lead = byId.get(a.variantOf);
      assert.ok(lead?.variants, `${a.id}: ${a.variantOf} has no versions`);
      assert.ok(lead.variants.some((v) => v.id === a.id), `${a.id} is missing from ${a.variantOf}'s versions`);
    }
    if (a.variants) {
      assert.equal(a.variants[0].id, a.id, `${a.id}: the card's own version comes first`);
      for (const v of a.variants) {
        assert.ok(ids.has(v.id), `${a.id}: ${v.id}`);
        assert.ok(v.label, `${a.id}: ${v.id} has no label`);
      }
    }
  }
  for (const name of ["Java JDK", "Node.js", "Python", "Go"]) {
    assert.ok(catalog.apps.some((a) => a.groupName === name && a.variants.length > 1), `${name} has a version picker`);
  }
});

test("dependencies and families name real apps", () => {
  for (const a of catalog.apps) for (const r of a.requires || []) assert.ok(ids.has(r), `${a.id} requires ${r}`);
  for (const f of catalog.families) for (const id of f.members) assert.ok(ids.has(id), `${f.slug}: ${id}`);
});

test("every category belongs to a group", () => {
  const grouped = new Set(catalog.groups.flatMap((g) => g.categories.map((c) => c.slug)));
  for (const c of categories) assert.ok(grouped.has(c), c);
});

test("shared links keep working: every app has a permanent slot, none reused", () => {
  assert.equal(new Set(stableIds).size, stableIds.length, "a slot id appears twice");
  for (const id of ids) assert.ok(stableIds.includes(id), `${id} has no slot`);
  assert.deepEqual(catalog.order, stableIds);
});
