# data/

Everything the build reads. Files are either **yours** (edit by hand) or **generated** (a script writes them; don't edit).

## Yours: what is in the catalog

| File | What it holds |
|---|---|
| `apps.json` | The core picks that Homebrew knows about: name, description, repo, category. To drop an app, delete its entry here. To move it, change its `category`. |
| `extras.json` | Apps added later, one entry each. Four kinds: `cask` (a Homebrew cask), `github` (the latest GitHub release), `direct` (a fixed download link), `resolver` (Node, Python, Go). |
| `builtins.json` | Things installed through Apple or npm, with no download: Xcode, the command-line tools, Mac App Store apps, Pi. |
| `overrides.json` | Fixes when an `apps.json` entry matches the wrong Homebrew cask (`"slug": "cask-token"`, or `null` to skip). |
| `exclude.json` | A blocklist of `apps.json` slugs to hide without deleting them. Empty today. |

## Yours: how it is organised

| File | What it holds |
|---|---|
| `groups.json` | The two-level navigation: ten groups (Development, Design, Multimedia ...), each listing its categories, with the short names used under a group ("Editors", not "Code Editors"). A category no group lists still shows up, under "More". |
| `extra-categories.json` | Categories `apps.json` doesn't have (Email, Launchers, 3D Printing ...), and where they go in the order. |
| `also-in.json` | Extra categories an app is listed under, as well as its own. |
| `profiles.json` | The starter packs ("Developer", "Designer" ...). Their apps get the Recommended badge. |
| `families.json` | Apps from one publisher, shown together in the details (Objective-See, JetBrains ...). |
| `requires.json` | Dependencies: picking Pi adds Node.js, Homebrew adds the command-line tools. |
| `media-overrides.json` | Icons, screenshots or homepages set by hand when the automatic search gets it wrong. |
| `category-overrides.json` | Moves an `apps.json` app to another category without editing it. Empty today: edit `apps.json` instead. |

## Generated

| File | Written by | What it is |
|---|---|---|
| `stable-ids.json` | `npm run build` | A permanent slot number per app, so shared links keep working. **Append-only: never reorder or delete.** |
| `skipped.txt` | `npm run build` | Apps that couldn't be installed automatically, with the reason. |
| `hashes.json` | `npm run build` | Checksums computed for big downloads, so they aren't re-downloaded each build. |
| `media.json` | `npm run media` | Icons and screenshots found for each app. |
| `media-missing.txt` | `npm run media` | Apps that still have no screenshot. |
| `arch.json` | `npm run arch` | Which chips each zip download really supports (read from the app's binary). |
