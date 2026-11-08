#!/usr/bin/env bash
set -euo pipefail

requested="${1:-}"
file="${2:-}"

if [ -n "$requested" ]; then
  echo "$requested"
  exit 0
fi
if [ -z "$file" ]; then
  echo latest
  exit 0
fi
[ -f "$file" ] || { echo "::error::bun-version-file $file does not exist" >&2; exit 1; }

case "$(basename "$file")" in
  package.json)
    version=$(grep -o '"packageManager"[[:space:]]*:[[:space:]]*"bun@[^"]*"' "$file" | sed 's/.*"bun@\([^"]*\)"/\1/' | head -1)
    ;;
  .tool-versions)
    version=$(awk '$1 == "bun" { print $2; exit }' "$file")
    ;;
  *)
    version=$(tr -d '[:space:]' < "$file")
    ;;
esac
version="${version#v}"
[ -n "$version" ] || { echo "::error::No Bun version found in $file" >&2; exit 1; }
echo "$version"
