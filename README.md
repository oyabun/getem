# Getem.sh

A curated list of Mac apps for setting up a new Mac quickly. Pick apps (or a starter pack for your role) on a web page and get one Terminal command that installs them all:

```sh
curl -fsSL https://your-site/install.sh | bash -s -- iina rectangle stats
```

- **The list is ours.** `data/apps.json` holds the core picks, `data/extras.json` the apps added later and `data/builtins.json` the ones installed through Apple or npm. Nothing is pulled in automatically, so an app is listed only if we chose it.
- **Starter packs:** `data/profiles.json` defines the role packs (Developer, Designer ...). Apps in the chosen pack get a Recommended badge. `data/families.json` groups apps from one publisher.
- **Versions, download URLs and SHA-256 checksums:** from the [Homebrew Cask API](https://formulae.brew.sh/api/cask.json) or, for apps outside Homebrew, the publisher's GitHub release page or a fixed download link. Homebrew itself is not needed on the user's Mac.
- **Installer:** downloads from each publisher, verifies the checksum, and handles dmg, zip, tar and pkg files. It picks the Apple Silicon or Intel build and skips apps that are already up to date. Add `--dry-run` to preview or `--force` to reinstall.
- **Download .sh:** the page can also produce a script with the chosen apps built in.

## Develop

```sh
npm run build   # refresh versions and checksums → public/catalog.json, catalog.tsv, install.sh
npm run media   # find icons and screenshots for new apps (add -- --deep for a harder pass)
npm run dev     # http://localhost:3000
```

Curating: see `data/README.md` for what each file does. In short: delete an entry from `data/apps.json` to
drop an app (or from `data/extras.json` for later additions), change its `category` there to move it, and use
`data/media-overrides.json` to set its icon or screenshots by hand. Apps that can't be installed automatically
are listed in `data/skipped.txt`, with the reason.

## Deploy

Any static host works. On Vercel, `vercel.json` already sets the build. `SITE_URL` is filled in
from `VERCEL_PROJECT_PRODUCTION_URL`; set `SITE_URL` yourself for other hosts. Versions are
fixed at build time, so rebuild daily (for example with a scheduled GitHub Action calling a Vercel
deploy hook) to stay current.

## Credits

Icons are [Lucide](https://lucide.dev) (ISC license), inlined in `public/icons.js`.
