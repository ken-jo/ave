#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  metadata)
    version="$(tr -d '[:space:]' < "$BUN_VERSION_FILE")"
    if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "$BUN_VERSION_FILE must hold an exact version, found '$version'" >&2
      exit 1
    fi
    case "$RUNNER_ARCH" in
      X64) asset="bun-windows-x64" ;;
      ARM64) asset="bun-windows-aarch64" ;;
      *) echo "no Windows release for runner architecture $RUNNER_ARCH" >&2; exit 1 ;;
    esac
    # A version bump without a reviewed archive pin fails closed.
    case "$version:$asset" in
      1.4.4:bun-windows-x64) pinned=cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5 ;;
      1.4.4:bun-windows-aarch64) pinned=2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09 ;;
      *) echo "no pinned SHA-256 for $asset.zip of v$version" >&2; exit 1 ;;
    esac
    printf 'version=%s\nasset=%s\npinned=%s\nkey=bun-archive-v1-%s-%s-%s\n' \
      "$version" "$asset" "$pinned" "$version" "$asset" "$pinned" >> "$GITHUB_OUTPUT"
    ;;
  verify)
    : "${VERSION:?}" "${ASSET:?}" "${PINNED:?}"
    work="$RUNNER_TEMP/bun-download"
    if [ "${CACHE_HIT:-}" != true ]; then
      rm -rf "$work"
      mkdir -p "$work"
      base="https://github.com/oven-sh/bun/releases/download/bun-v${VERSION}"
      for file in "$ASSET.zip" SHASUMS256.txt; do
        curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 6 --retry-delay 5 --retry-max-time 180 \
          --output "$work/$file" "$base/$file"
      done
    fi
    # Hash stdin so backslashes in a path cannot escape the digest output.
    actual="$(sha256sum < "$work/$ASSET.zip" | awk '{ print $1 }')"
    if ! [[ "$PINNED" =~ ^[0-9a-f]{64}$ ]] || [ "$actual" != "$PINNED" ]; then
      echo "$ASSET.zip SHA-256 $actual does not match the pinned $PINNED" >&2
      exit 1
    fi
    expected="$(awk -v name="$ASSET.zip" '$2 == name { print $1 }' "$work/SHASUMS256.txt")"
    if ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || [ "$actual" != "$expected" ]; then
      echo "$ASSET.zip SHA-256 $actual does not match the release's $expected" >&2
      exit 1
    fi
    echo "$ASSET.zip v$VERSION SHA-256 $actual matches the pin and SHASUMS256.txt"
    ;;
  *) echo 'expected metadata or verify' >&2; exit 1 ;;
esac
