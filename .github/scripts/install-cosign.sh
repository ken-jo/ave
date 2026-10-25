#!/usr/bin/env bash
# Puts the pinned cosign release on PATH for the rest of a Linux job without a
# third-party action. The binary for this machine's architecture is downloaded
# from the sigstore/cosign GitHub release into $RUNNER_TEMP and must equal the
# sha256 recorded here (copied from that release's cosign_checksums.txt and
# re-hashed from the downloaded binaries). A cosign already on the runner is
# never used: the signature on a release must come from the pinned build.
# Nothing here reads a secret.
set -euo pipefail

COSIGN_VERSION="v3.1.3"
COSIGN_SHA256_AMD64="4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71"
COSIGN_SHA256_ARM64="c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a"

: "${RUNNER_TEMP:?RUNNER_TEMP is not set}"
: "${GITHUB_PATH:?GITHUB_PATH is not set}"
if [ "$(uname -s)" != "Linux" ]; then
  echo "install-cosign.sh installs the Linux build only; this runner is $(uname -s)" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64 | arm64) arch=arm64; expected="$COSIGN_SHA256_ARM64" ;;
  x86_64 | amd64) arch=amd64; expected="$COSIGN_SHA256_AMD64" ;;
  *)
    echo "No pinned cosign build for machine architecture $(uname -m)" >&2
    exit 1
    ;;
esac
for tool in curl sha256sum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required to install and verify cosign" >&2
    exit 1
  fi
done

bin_dir="$RUNNER_TEMP/cosign-bin"
rm -rf "$bin_dir"
mkdir -p "$bin_dir"
url="https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-${arch}"
curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  --output "$bin_dir/cosign.download" "$url"
actual="$(sha256sum "$bin_dir/cosign.download" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "cosign $COSIGN_VERSION ($arch) has sha256 $actual, expected $expected" >&2
  rm -rf "$bin_dir"
  exit 1
fi
mv "$bin_dir/cosign.download" "$bin_dir/cosign"
chmod 0755 "$bin_dir/cosign"
echo "Verified cosign $COSIGN_VERSION ($arch) sha256 $actual"
"$bin_dir/cosign" version
echo "$bin_dir" >> "$GITHUB_PATH"
