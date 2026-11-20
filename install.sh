#!/bin/sh
# Installs the latest node-ctl release, or updates it: run it again for the next one.
#   curl -fsSL https://raw.githubusercontent.com/pro100coder/node-ctl/main/install.sh | sh
# NODE_CTL_BIN_DIR is where it goes (~/.local/bin), NODE_CTL_RELEASES replaces
# https://github.com/pro100coder/node-ctl/releases. NODE_CTL_UNAME_S and NODE_CTL_UNAME_M replace
# uname -s and uname -m; only the tests set them.
# Everything is in functions and main runs on the last line: a download cut short runs nothing.
set -eu

die() {
  echo "install.sh: $*" >&2
  exit 1
}

asset_name() {
  os=${NODE_CTL_UNAME_S:-$(uname -s)}
  arch=${NODE_CTL_UNAME_M:-$(uname -m)}
  case $os in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "unsupported OS: $os (node-ctl runs on macOS and Linux)" ;;
  esac
  case $arch in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "unsupported architecture: $arch (node-ctl is built for arm64 and x86_64)" ;;
  esac
  echo "node-ctl-$os-$arch"
}

fetch() { # fetch <url> <file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1" || die "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "could not download $1"
  else
    die "needs curl or wget to download $1"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

main() {
  asset=$(asset_name)
  releases=${NODE_CTL_RELEASES:-https://github.com/pro100coder/node-ctl/releases}
  bin_dir=${NODE_CTL_BIN_DIR:-$HOME/.local/bin}
  dest=$bin_dir/node-ctl
  mkdir -p "$bin_dir" || die "could not create $bin_dir"
  # The binary is downloaded next to its destination, so the mv over it is a rename: the path a scheduled
  # stop runs never holds half a binary, and a failure leaves the one there as it was.
  sums=$(mktemp "${TMPDIR:-/tmp}/node-ctl-checksums.XXXXXX")
  tmp=$(mktemp "$bin_dir/.node-ctl.XXXXXX")
  trap 'rm -f "$sums" "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM
  fetch "$releases/latest/download/checksums.txt" "$sums"
  fetch "$releases/latest/download/$asset" "$tmp"
  want=$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' "$sums")
  [ -n "$want" ] || die "checksums.txt has no $asset; $dest is left as it was"
  got=$(sha256_of "$tmp")
  [ "$got" = "$want" ] || die "the sha256 of $asset is $got and does not match checksums.txt ($want); $dest is left as it was"
  chmod 755 "$tmp"
  # curl sets no quarantine attribute, but a binary that came through a browser or AirDrop would refuse to start
  if command -v xattr >/dev/null 2>&1; then xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true; fi
  # A link (the bash CLI's checkout left one) becomes the file: launchd and systemd jobs run this path.
  mv -f "$tmp" "$dest" || die "could not write $dest"
  echo "installed $asset as $dest"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo "$bin_dir is not on PATH; add it in your shell profile: export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
}

main "$@"
