#!/usr/bin/env bash
set -euo pipefail

requested="${1:-latest}"
dest="${2:-$HOME/.bun}"
registry="${NPM_REGISTRY:-https://registry.npmjs.org}"

case "$requested" in
  latest|"") version=$(curl -fsSL --retry 5 --retry-all-errors "$registry/bun/latest" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4) ;;
  *) version="${requested#v}" ;;
esac
[ -n "$version" ] || { echo "::error::Could not resolve Bun version '$requested' from $registry"; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  *) echo "::error::No npm build of Bun for $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "::error::No npm build of Bun for $(uname -m)"; exit 1 ;;
esac

pkg="bun-$os-$arch"
work=$(mktemp -d)
curl -fsSL --retry 5 --retry-all-errors "$registry/@oven/$pkg/-/$pkg-$version.tgz" -o "$work/bun.tgz"
tar -xzf "$work/bun.tgz" -C "$work"

exe=bun
[ "$os" = windows ] && exe=bun.exe
mkdir -p "$dest/bin"
cp "$work/package/bin/$exe" "$dest/bin/$exe"
chmod +x "$dest/bin/$exe"
rm -rf "$work"

"$dest/bin/$exe" --version
echo "$version"
