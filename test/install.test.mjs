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
