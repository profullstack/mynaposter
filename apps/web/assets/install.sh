#!/bin/sh
# myna installer — https://mynaposter.com
#
#   curl -fsSL https://mynaposter.com/install.sh | sh
#
# Downloads a standalone binary for this platform, checks it against the
# published SHA256SUMS, and installs it. Nothing else is needed: the binary
# embeds its runtime, so there is no Bun, Node or npm requirement.
#
# Environment:
#   MYNA_VERSION   version to install, e.g. 0.1.0 (default: latest release)
#   MYNA_BIN       directory to install into (default: /usr/local/bin, else ~/.local/bin)
#   MYNA_NO_VERIFY set to 1 to skip the checksum check (not recommended)

set -eu

REPO="profullstack/mynaposter"
VERSION="${MYNA_VERSION:-latest}"

red()  { printf '\033[31m%s\033[0m\n' "$1" >&2; }
dim()  { printf '\033[2m%s\033[0m\n' "$1" >&2; }
bold() { printf '\033[1m%s\033[0m\n' "$1" >&2; }

die() { red "install failed: $1"; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "this installer needs $1"
}

need uname
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "this installer needs curl or wget"

fetch() {
  # $1 url, $2 destination ("-" for stdout)
  if command -v curl >/dev/null 2>&1; then
    if [ "$2" = "-" ]; then curl -fsSL "$1"; else curl -fsSL "$1" -o "$2"; fi
  else
    if [ "$2" = "-" ]; then wget -qO- "$1"; else wget -qO "$2" "$1"; fi
  fi
}

# ── platform ────────────────────────────────────────────────────────────────

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    die "run the Windows installer instead: https://github.com/$REPO/releases" ;;
  *) die "unsupported operating system: $os" ;;
esac

case "$arch" in
  x86_64|amd64)  arch="x86_64" ;;
  aarch64|arm64) arch="$([ "$os" = "darwin" ] && echo arm64 || echo aarch64)" ;;
  *) die "unsupported architecture: $arch" ;;
esac

asset="myna-${os}-${arch}"

# Bun's default x86_64 build uses AVX2. Older CPUs need the baseline build, and
# picking wrong means the binary dies with an illegal instruction rather than a
# readable error, so this checks before downloading rather than after.
if [ "$os" = "linux" ] && [ "$arch" = "x86_64" ] && [ -r /proc/cpuinfo ]; then
  if ! grep -qm1 ' avx2 ' /proc/cpuinfo && ! grep -qm1 ' avx2$' /proc/cpuinfo; then
    dim "This CPU has no AVX2; using the baseline build."
    asset="${asset}-baseline"
  fi
fi

# ── version ─────────────────────────────────────────────────────────────────

if [ "$VERSION" = "latest" ]; then
  tag="$(fetch "https://api.github.com/repos/$REPO/releases/latest" - \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$tag" ] || die "could not find the latest release. Set MYNA_VERSION to install a specific one."
else
  case "$VERSION" in v*) tag="$VERSION" ;; *) tag="v$VERSION" ;; esac
fi

base="https://github.com/$REPO/releases/download/$tag"

# ── destination ─────────────────────────────────────────────────────────────

if [ -n "${MYNA_BIN:-}" ]; then
  dest="$MYNA_BIN"
elif [ -w /usr/local/bin ] 2>/dev/null; then
  dest="/usr/local/bin"
else
  dest="$HOME/.local/bin"
fi
mkdir -p "$dest" || die "cannot create $dest"
[ -w "$dest" ] || die "$dest is not writable. Set MYNA_BIN to somewhere you can write."

# ── download ────────────────────────────────────────────────────────────────

tmp="$(mktemp -d "${TMPDIR:-/tmp}/myna-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

bold "Installing myna $tag ($asset)"
fetch "$base/$asset" "$tmp/myna" || die "could not download $base/$asset"
[ -s "$tmp/myna" ] || die "the download was empty"

# ── verify ──────────────────────────────────────────────────────────────────

if [ "${MYNA_NO_VERIFY:-0}" != "1" ]; then
  if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null && [ -s "$tmp/SHA256SUMS" ]; then
    expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}' | head -n1)"
    if [ -n "$expected" ]; then
      if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$tmp/myna" | awk '{print $1}')"
      elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$tmp/myna" | awk '{print $1}')"
      else
        actual=""
        dim "No sha256 tool found; skipping verification."
      fi
      if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
        die "checksum mismatch for $asset. Refusing to install."
      fi
    else
      dim "No checksum published for $asset; skipping verification."
    fi
  else
    dim "Could not fetch SHA256SUMS; skipping verification."
  fi
fi

# ── install ─────────────────────────────────────────────────────────────────

chmod +x "$tmp/myna"
# Stage beside the target and rename, so a running myna is never half-replaced.
if ! mv -f "$tmp/myna" "$dest/myna.new"; then
  die "could not write to $dest"
fi
if ! mv -f "$dest/myna.new" "$dest/myna"; then
  rm -f "$dest/myna.new"
  die "could not install into $dest"
fi

bold "Installed $dest/myna"

case ":${PATH}:" in
  *":$dest:"*) ;;
  *)
    dim ""
    dim "$dest is not on your PATH. Add it:"
    dim "  echo 'export PATH=\"$dest:\$PATH\"' >> ~/.profile"
    ;;
esac

printf '\n'
if "$dest/myna" --version >/dev/null 2>&1; then
  bold "Try:  myna login bluesky"
else
  dim "Installed, but the binary did not run. Please open an issue."
fi
printf '%s\n' "Docs: https://mynaposter.com"
