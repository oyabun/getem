// The installer script, run for real in --dry-run and --list modes against the built catalog (no network, no
// installs: both modes work off macOS too). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../src/install.sh", import.meta.url));
const catalogUrl = new URL("../public/catalog.tsv", import.meta.url).href;
const run = (...args) => {
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, CATALOG_URL: catalogUrl, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout + r.stderr };
};

test("the script is valid bash", () => {
  const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("--list prints every id in the catalog", () => {
  const { code, out } = run("--list");
  assert.equal(code, 0, out);
  for (const id of ["vlc", "node", "node-22", "temurin@21", "gh", "homebrew"]) assert.match(out, new RegExp(`^${id.replace(/[.@]/g, "\\$&")}\\s`, "m"), id);
});

test("--dry-run shows what it would download and install, and installs nothing", () => {
  const { code, out } = run("--dry-run", "vlc", "node-22", "gh");
  assert.equal(code, 0, out);
  assert.match(out, /would download https:\/\/get\.videolan\.org\//);
  assert.match(out, /would download https:\/\/nodejs\.org\/dist\/v22\./);
  assert.match(out, /would run the installer package gh\.pkg/);
  assert.match(out, /Would install \(dry run\): vlc node-22 gh/);
});

test("an unknown id is reported, not silently skipped", () => {
  const { out } = run("--dry-run", "vlc", "not-a-real-app");
  assert.match(out, /not-a-real-app: not in the catalog/);
  assert.match(out, /Failed: not-a-real-app/);
});

test("Homebrew's dependency, the command-line tools, is installed first", () => {
  const { out } = run("--dry-run", "homebrew", "xcode-cli");
  assert.ok(out.indexOf("Command Line Tools") < out.indexOf("Homebrew"), out);
});

test("an existing Homebrew is never installed over, even with --force", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  writeFileSync(join(dir, "brew"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "brew"), 0o755);
  const r = spawnSync("bash", [script, "--dry-run", "--force", "homebrew"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CATALOG_URL: catalogUrl, NO_COLOR: "1" } });
  const out = r.stdout + r.stderr;
  assert.match(out, /already installed .*leaving it as is/, out);
  assert.doesNotMatch(out, /would (download|install)/i, out);
});

// Homebrew mode. A fake Homebrew prefix stands in for the user's: bin/brew on PATH, and a Caskroom/Cellar folder for
// each package in `manages` (that is how the script tells, without running brew).
const withFakeBrew = async (manages, ...args) => {
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const prefix = mkdtempSync(join(tmpdir(), "fake-brew-"));
  mkdirSync(join(prefix, "bin"));
  writeFileSync(join(prefix, "bin", "brew"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(prefix, "bin", "brew"), 0o755);
  for (const m of manages.split(/\s+/).filter(Boolean)) mkdirSync(join(prefix, "Caskroom", m.split("/").pop()), { recursive: true });
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${join(prefix, "bin")}:${process.env.PATH}`, CATALOG_URL: catalogUrl, NO_COLOR: "1" } });
  return r.stdout + r.stderr;
};

test("without Homebrew in the list, apps download from the publisher", () => {
  const { out } = run("--dry-run", "vlc");
  assert.match(out, /would download https:/, out);
  assert.doesNotMatch(out, /brew install/, out);
});

test("picking Homebrew alone just installs Homebrew; apps still come from their publisher", () => {
  const { out } = run("--dry-run", "homebrew", "vlc");
  assert.match(out, /VLC[\s\S]*would download https:/, out);
  assert.doesNotMatch(out, /brew install --cask vlc/, out);
});

test("--brew installs Homebrew first when it's missing, then the apps through it", () => {
  const { out } = run("--dry-run", "--brew", "vlc");
  assert.ok(out.indexOf("Command Line Tools") < out.indexOf("Homebrew") && out.indexOf("Homebrew") < out.indexOf("VLC"), out);
  assert.match(out, /brew install --cask vlc/, out);
  assert.doesNotMatch(out, /VLC[\s\S]*would download https:/, out);
});

test("--brew uses the Homebrew that is already there", async () => {
  const out = await withFakeBrew("", "--dry-run", "--brew", "vlc");
  assert.match(out, /would run: brew install --cask vlc/, out);
});

test("without --brew, an app Homebrew manages is left alone: no brew, no overwrite", async () => {
  const out = await withFakeBrew("vlc", "--dry-run", "vlc");
  assert.match(out, /managed by Homebrew, so left as it is \(update it with: brew upgrade --cask vlc\)/, out);
  assert.doesNotMatch(out, /would download|would run: brew/, out);
  assert.match(out, /Managed by Homebrew, left as is .*vlc/, out);
});

test("with --brew, an app Homebrew manages is upgraded through it", async () => {
  const out = await withFakeBrew("vlc", "--dry-run", "--brew", "vlc");
  assert.match(out, /managed by Homebrew; would run: brew upgrade --cask vlc/, out);
});

test("apps without a cask still download from the publisher in Homebrew mode", async () => {
  const noCask = (await import("node:fs")).readFileSync(new URL("../public/catalog.tsv", import.meta.url), "utf8")
    .split("\n").map((l) => l.split("\t")).find((f) => f[1] === "app" && f[14] === "-")?.[0];
  assert.ok(noCask, "the catalog has an app without a cask");
  const out = await withFakeBrew("", "--dry-run", "--brew", noCask);
  assert.match(out, /would download https:/, out);
});

test("--update next to a list still installs the list (and moves what's already there)", () => {
  const { code, out } = run("--dry-run", "--brew", "--update", "vlc");
  assert.equal(code, 0, out);
  assert.equal((out.match(/==> VLC/g) || []).length, 1, out);
  assert.match(out, /brew install --cask vlc/, out);
});

test("a package in the publisher's own tap installs without --cask, after trusting the tap", async () => {
  const out = await withFakeBrew("", "--dry-run", "--brew", "docker-sandboxes");
  assert.match(out, /would trust the docker\/tap tap: brew trust docker\/tap/, out);
  assert.match(out, /would run: brew install docker\/tap\/sbx/, out);
  assert.doesNotMatch(out, /--cask docker/, out);
});

test("with --brew, a tap package Homebrew already manages is upgraded through Homebrew", async () => {
  const out = await withFakeBrew("docker/tap/sbx", "--dry-run", "--brew", "docker-sandboxes");
  assert.match(out, /managed by Homebrew; would run: brew upgrade docker\/tap\/sbx/, out);
});

test("the default never runs Homebrew, even when it is installed", async () => {
  const out = await withFakeBrew("", "--dry-run", "vlc", "docker-sandboxes");
  assert.doesNotMatch(out, /brew (install|upgrade|trust)/, out);
  assert.match(out, /VLC[\s\S]*would download https:/, out);
});

test("with --brew, id:direct keeps that one app on the publisher's download", async () => {
  const out = await withFakeBrew("", "--dry-run", "--brew", "vlc:direct", "docker-sandboxes");
  assert.match(out, /would download https:/, out);
  assert.doesNotMatch(out, /--cask vlc/, out);
  assert.match(out, /brew install docker\/tap\/sbx/, out);
});

test("id:direct still leaves an app Homebrew manages alone", async () => {
  const out = await withFakeBrew("vlc", "--dry-run", "--brew", "vlc:direct");
  assert.match(out, /managed by Homebrew, so left as it is/, out);
});
