#!/bin/bash
# Getem.sh — set up a Mac: install a curated list of apps straight from their publishers.
#
#   curl -fsSL __SITE_URL__/install.sh | bash -s -- iina rectangle stats
#
# Options: --dry-run (show what would happen), --force (reinstall up-to-date apps),
#          --list (print available app ids), --update (update every catalog app you already have).
# Every download is checked against a published SHA-256 (Homebrew Cask API or the publisher's release).
# Written for the bash 3.2 that ships with macOS. Everything runs inside main() so a
# partially downloaded script never executes.

set -euo pipefail

CATALOG_URL="${CATALOG_URL:-__SITE_URL__/catalog.tsv}"
BROWSER_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

# @@EMBED_START@@ (downloaded scripts carry their own catalog and app list here)
EMBEDDED=0
DEFAULT_APPS=""
embedded_catalog() { :; }
# @@EMBED_END@@

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
fail() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
die()  { printf '%sError:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  say "Usage: install.sh [--dry-run] [--force] [--list] [--update] APP_ID..."
  say "  --update  bring every app from the catalog that is already in /Applications up to date"
  say "Pick apps at __SITE_URL__"
}

load_catalog() {
  if [ "$EMBEDDED" = 1 ]; then
    embedded_catalog
  else
    curl -fsSL --retry 3 "$CATALOG_URL" || die "could not download the catalog from $CATALOG_URL"
  fi
}

# Print the catalog row for an app id.
lookup() {
  # A here-string, not a pipe: with pipefail, awk stopping early would kill the writer with SIGPIPE and fail the lookup.
  awk -F'\t' -v id="$1" '$1 == id { print; exit }' <<<"$CATALOG"
}

macos_major() { sw_vers -productVersion 2>/dev/null | cut -d. -f1; }

bundle_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || true
}

# Run a command, retrying with sudo if we lack permission (e.g. a root-owned app bundle).
as_needed() { "$@" 2>/dev/null || sudo "$@"; }

container_type() {
  local url="${1%%\?*}" file="$2"
  case "$url" in
    *.dmg) echo dmg; return ;;
    *.zip) echo zip; return ;;
    *.pkg|*.mpkg) echo pkg; return ;;
    *.tar|*.tar.gz|*.tgz|*.tar.bz2|*.tbz|*.tar.xz|*.txz) echo tar; return ;;
  esac
  case "$(file -b "$file")" in
    Zip*) echo zip ;;
    xar*) echo pkg ;;
    POSIX\ tar*|gzip*|XZ*) echo tar ;;
    *) echo dmg ;;   # disk images have no reliable magic; let hdiutil decide
  esac
}

# Built-in installs have no download: Apple doesn't offer these as files, so each has a fixed handler.
install_xcode_cli() {
  if xcode-select -p >/dev/null 2>&1 && [ -x "$(xcode-select -p)/usr/bin/git" ]; then
    ok "already installed"
    echo uptodate > "$STATUS_FILE"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  ${DIM}would install the Command Line Tools with softwareupdate${RESET}"
    echo planned > "$STATUS_FILE"
    return 0
  fi
  # The placeholder file makes softwareupdate list the Command Line Tools as an available update.
  local flag=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress label
  touch "$flag"
  label="$(softwareupdate -l 2>/dev/null | grep -B 1 -E 'Command Line Tools' | awk -F'*' '/^ *\*/ {print $2}' | sed -e 's/^ *Label: //' -e 's/^ *//' | sort -V | tail -n1 || true)"
  if [ -n "$label" ]; then
    sudo softwareupdate -i "$label" --verbose </dev/null || { rm -f "$flag"; fail "softwareupdate could not install $label"; }
    rm -f "$flag"
    ok "installed"
    echo installed > "$STATUS_FILE"
  else
    rm -f "$flag"
    warn "no update found; opening Apple's installer dialog instead"
    xcode-select --install >/dev/null 2>&1 || true
    say "  Click Install in the dialog that appeared."
    echo manual > "$STATUS_FILE"
  fi
}

# Mac App Store apps can't be downloaded as files. Use mas if it is installed, else open the store page.
install_appstore() {
  local store_id="$1" dest="$2" name="$3"
  if [ -d "/Applications/$dest" ]; then
    ok "already installed ($(bundle_version "/Applications/$dest"))"
    echo uptodate > "$STATUS_FILE"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  ${DIM}would open $name in the Mac App Store${RESET}"
    echo planned > "$STATUS_FILE"
    return 0
  fi
  if command -v mas >/dev/null 2>&1; then
    if mas install "$store_id" </dev/null; then
      ok "installed"
      echo installed > "$STATUS_FILE"
      return 0
    fi
    warn "mas could not install it (are you signed in to the App Store?)"
  fi
  open "macappstore://apps.apple.com/app/id$store_id" || true
  say "  $name is only available from the Mac App Store. Click Get in the window that opened."
  [ "$dest" = Xcode.app ] && say "  ${DIM}Afterwards: sudo xcodebuild -license accept${RESET}"
  echo manual > "$STATUS_FILE"
}

# Command-line tools published on npm (Pi, and others later). npm brings its own integrity checks.
install_npm() {
  local pkg="$1" name="$3" npm_bin="" p
  npm_bin="$(command -v npm 2>/dev/null || true)"
  if [ -z "$npm_bin" ]; then
    for p in /usr/local/bin/npm /opt/homebrew/bin/npm; do [ -x "$p" ] && { npm_bin="$p"; break; }; done
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  ${DIM}would run: npm install -g --ignore-scripts $pkg${RESET}"
    echo planned > "$STATUS_FILE"
    return 0
  fi
  [ -n "$npm_bin" ] || fail "$name needs npm. Pick Node.js (LTS) from the Languages & Runtimes list too, or install Node first"
  local action=installed
  "$npm_bin" ls -g --depth=0 "$pkg" >/dev/null 2>&1 && action=updated
  as_needed "$npm_bin" install -g --ignore-scripts "$pkg" >/dev/null || fail "npm could not install $pkg"
  ok "$action"
  echo "$action" > "$STATUS_FILE"
}

# Installs one app in a subshell; writes its outcome to $STATUS_FILE.
install_one() {
  local id="$1" row
  row="$(lookup "$id")"
  [ -n "$row" ] || fail "$id: not in the catalog (run with --list to see ids)"

  local kind src dest version min url_arm sha_arm url_intel sha_intel ua referer name bin
  IFS=$'\t' read -r _ kind src dest version min url_arm sha_arm url_intel sha_intel ua referer name bin <<EOF
$row
EOF
  step "$name ${DIM}$version${RESET}"

  if [ "$min" != - ] && [ -n "$MACOS" ] && [ "$MACOS" -lt "$min" ]; then
    fail "needs macOS $min or later"
  fi

  if [ "$kind" = builtin ]; then
    case "$src" in
      xcode-cli) install_xcode_cli ;;
      appstore:*) install_appstore "${src#appstore:}" "$dest" "$name" ;;
      npm:*)      install_npm "${src#npm:}" "$dest" "$name" ;;
      *)         fail "unknown built-in installer: $src" ;;
    esac
    return 0
  fi

  # Homebrew has no app bundle to compare, so recognise an existing install by its binary.
  if [ "$id" = homebrew ] && [ "$FORCE" = 0 ]; then
    local b
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      if [ -x "$b" ]; then ok "already installed"; echo uptodate > "$STATUS_FILE"; return 0; fi
    done
  fi

  # Runtimes installed from a package have no app bundle either; compare the version they report.
  if [ "$kind" = pkg ] && [ "$FORCE" = 0 ]; then
    local have=""
    case "$id" in
      node|node-*)       have="$(/usr/local/bin/node -v 2>/dev/null | sed 's/^v//' || true)" ;;
      go|go-*)           have="$(/usr/local/go/bin/go version 2>/dev/null | sed -n 's/^go version go\([0-9.]*\).*/\1/p' || true)" ;;
      # each Python minor installs side by side (python3.14, python3.13 ...), so ask the one this id is for
      python3|python3-*) have="$(/usr/local/bin/python"${version%.*}" -V 2>/dev/null | sed 's/^Python //' || true)" ;;
      gh)                have="$(/usr/local/bin/gh --version 2>/dev/null | sed -n 's/^gh version \([0-9.]*\).*/\1/p' || true)" ;;
    esac
    if [ -n "$have" ] && [ "$have" = "$version" ]; then
      ok "already up to date"
      echo uptodate > "$STATUS_FILE"
      return 0
    fi
    [ -n "$have" ] && say "  ${DIM}installed: $have${RESET}"
  fi

  local url sha
  if [ "$ARCH" = arm ]; then
    url="$url_arm" sha="$sha_arm"
  else
    [ "$url_intel" != - ] || fail "Apple Silicon only"
    url="$url_intel" sha="$sha_intel"
  fi

  local dir=""
  case "$kind" in
    app)          dir="/Applications" ;;
    qlplugin)     dir="$HOME/Library/QuickLook" ;;
    screen_saver) dir="$HOME/Library/Screen Savers" ;;
    prefpane)     dir="$HOME/Library/PreferencePanes" ;;
  esac

  local action=installed
  if [ -n "$dir" ] && [ -e "$dir/$dest" ]; then
    local current
    current="$(bundle_version "$dir/$dest")"
    if [ "$current" = "$version" ] && [ "$FORCE" = 0 ]; then
      ok "already up to date"
      echo uptodate > "$STATUS_FILE"
      return 0
    fi
    action=updated
    [ -n "$current" ] && say "  ${DIM}installed: $current${RESET}"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    say "  ${DIM}would download $url${RESET}"
    if [ -n "$dir" ]; then say "  ${DIM}would copy $src to $dir/$dest${RESET}"; else say "  ${DIM}would run the installer package $src${RESET}"; fi
    [ "${bin:--}" != - ] && [ "$kind" = app ] && say "  ${DIM}would link /usr/local/bin/$(basename "$bin") to the command inside the app${RESET}"
    echo planned > "$STATUS_FILE"
    return 0
  fi

  local work="$TMP/$id" file
  mkdir -p "$work"
  file="$work/download"
  local curl_opts=(-fL --retry 3 --connect-timeout 20 -o "$file")
  [ -t 2 ] && curl_opts+=(--progress-bar) || curl_opts+=(-sS)
  if [ "$ua" = browser ]; then curl_opts+=(-A "$BROWSER_UA"); elif [ "$ua" != - ]; then curl_opts+=(-A "$ua"); fi
  [ "$referer" != - ] && curl_opts+=(-e "$referer")
  curl "${curl_opts[@]}" "$url" </dev/null || fail "download failed: $url"

  if [ "$sha" = - ]; then
    warn "the publisher doesn't provide a fixed checksum; skipping verification"
  else
    local got
    got="$(shasum -a 256 "$file" | awk '{print $1}')"
    [ "$got" = "$sha" ] || fail "checksum mismatch (expected $sha, got $got)"
  fi

  local root="$work/x"
  mkdir -p "$root"
  case "$(container_type "$url" "$file")" in
    dmg)
      # `yes` accepts license agreements some disk images show before mounting.
      (yes || true) | hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$root" "$file" >/dev/null \
        || fail "could not open the disk image"
      echo "$root" >> "$TMP/mounts"
      ;;
    zip) ditto -x -k "$file" "$root" || fail "could not unzip" ;;
    tar) tar -xf "$file" -C "$root" || fail "could not extract" ;;
    pkg) mv "$file" "$root/$src" ;;
  esac

  local path="$root/$src"
  if [ ! -e "$path" ]; then
    path="$(find "$root" -maxdepth 3 -name "$(basename "$src")" -print -quit 2>/dev/null || true)"
    if [ -z "$path" ] && [ "$kind" = app ]; then
      # The publisher may name the bundle differently; accept it if the download holds just one app.
      local apps
      apps="$(find "$root" -maxdepth 3 -name '*.app' -prune -print 2>/dev/null || true)"
      [ -n "$apps" ] && [ "$(printf '%s\n' "$apps" | wc -l)" -eq 1 ] && path="$apps"
    fi
    [ -n "$path" ] || fail "$src not found in the download"
  fi

  if [ "$kind" = pkg ]; then
    sudo installer -pkg "$path" -target / >/dev/null </dev/null || fail "the installer package failed"
  else
    mkdir -p "$dir"
    if [ -e "$dir/$dest" ]; then
      as_needed mv "$dir/$dest" "$work/previous" || fail "could not replace the existing $dest"
    fi
    if ! as_needed ditto "$path" "$dir/$dest"; then
      [ -e "$work/previous" ] && as_needed mv "$work/previous" "$dir/$dest"
      fail "could not copy $dest to $dir"
    fi
  fi

  # Some apps carry a command-line tool inside the bundle (Docker Sandboxes' sbx); put it on the PATH.
  if [ "${bin:--}" != - ] && [ "$kind" = app ]; then
    local link="/usr/local/bin/$(basename "$bin")"
    if as_needed mkdir -p /usr/local/bin && as_needed ln -sf "$dir/$dest/$bin" "$link"; then
      say "  ${DIM}linked $link${RESET}"
    else
      warn "could not link $link; run it as $dir/$dest/$bin"
    fi
  fi

  if grep -qxF "$root" "$TMP/mounts" 2>/dev/null; then
    hdiutil detach -quiet "$root" 2>/dev/null || true
  fi
  ok "$action"
  echo "$action" > "$STATUS_FILE"
}

cleanup() {
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
    if [ -f "$TMP/mounts" ]; then
      while IFS= read -r m; do hdiutil detach -quiet -force "$m" 2>/dev/null || true; done < "$TMP/mounts"
    fi
    rm -rf "$TMP" 2>/dev/null || sudo rm -rf "$TMP"
  fi
  [ -n "${SUDO_KEEPALIVE:-}" ] && kill "$SUDO_KEEPALIVE" 2>/dev/null || true
}

main() {
  DRY_RUN="${DRY_RUN:-0}" FORCE=0
  local ids="" list=0 update=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run|-n) DRY_RUN=1 ;;
      --force|-f)   FORCE=1 ;;
      --list|-l)    list=1 ;;
      --update|-u)  update=1 ;;
      --help|-h)    usage; exit 0 ;;
      -*)           die "unknown option $1" ;;
      *)            ids="$ids $1" ;;
    esac
    shift
  done
  [ -n "$ids" ] || ids="$DEFAULT_APPS"

  if [ "$(uname -s)" != Darwin ] && [ "$DRY_RUN" = 0 ] && [ "$list" = 0 ]; then
    die "this installer is for macOS"
  fi

  CATALOG="$(load_catalog | grep -v '^#')"
  if [ "$list" = 1 ]; then
    printf '%s\n' "$CATALOG" | awk -F'\t' '{ printf "%-28s %s\n", $1, $13 }'
    exit 0
  fi
  if [ "$update" = 1 ]; then
    local rid rkind rsrc rdest rest
    while IFS=$'\t' read -r rid rkind rsrc rdest rest; do
      [ "$rkind" = app ] && [ -e "/Applications/$rdest" ] && ids="$ids $rid"
    done <<CATALOG_ROWS
$CATALOG
CATALOG_ROWS
    [ -n "${ids// /}" ] || { say "None of the catalog's apps are installed in /Applications yet."; exit 0; }
  fi
  [ -n "${ids// /}" ] || { usage; exit 1; }

  # Things other installs depend on go first: the command-line tools, Homebrew, then Node (npm tools need it).
  local first="" rest="" want id
  for want in xcode-cli homebrew node; do
    for id in $ids; do [ "$id" = "$want" ] && first="$first $id"; done
  done
  for id in $ids; do
    case " $first " in *" $id "*) ;; *) rest="$rest $id" ;; esac
  done
  ids="$first$rest"

  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=arm; else ARCH=intel; fi
  MACOS="$(macos_major || true)"

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/getem.XXXXXX")"
  trap cleanup EXIT
  STATUS_FILE="$TMP/status"

  # Ask for the admin password once, up front, if any selected app ships as a .pkg.
  if [ "$DRY_RUN" = 0 ]; then
    local id
    for id in $ids; do
      if [ "$(lookup "$id" | cut -f2)" = pkg ] || [ "$(lookup "$id" | cut -f2,3)" = "$(printf 'builtin\txcode-cli')" ]; then
        say "Some apps use an installer package, which needs your admin password."
        sudo -v < /dev/tty
        ( while kill -0 $$ 2>/dev/null; do sudo -n true; sleep 50; done ) 2>/dev/null &
        SUDO_KEEPALIVE=$!
        break
      fi
    done
  fi

  local installed="" updated="" current="" planned="" manual="" failed="" n=0 status
  for id in $ids; do
    n=$((n + 1))
    : > "$STATUS_FILE"
    set +e
    ( set -e; install_one "$id" )
    set -e
    status="$(cat "$STATUS_FILE")"
    case "$status" in
      installed) installed="$installed $id" ;;
      updated)   updated="$updated $id" ;;
      uptodate)  current="$current $id" ;;
      planned)   planned="$planned $id" ;;
      manual)    manual="$manual $id" ;;
      *)         failed="$failed $id" ;;
    esac
  done

  say ""
  step "Done"
  [ -n "$installed" ] && say "  Installed:${installed}"
  [ -n "$updated" ]   && say "  Updated:${updated}"
  [ -n "$current" ]   && say "  Already up to date:${current}"
  [ -n "$planned" ]   && say "  Would install (dry run):${planned}"
  [ -n "$manual" ]    && say "  ${YELLOW}Needs a click from you to finish:${RESET}${manual}"
  [ -n "$failed" ]    && say "  ${RED}Failed:${failed}${RESET}"
  [ -z "$failed" ]
}

main "$@"
