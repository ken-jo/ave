#!/usr/bin/env bash
# Puts AWS CLI v2 on PATH for the rest of a Linux job without a third-party
# action. A runner that already has v2 keeps it. Otherwise the official
# installer zip for this machine's architecture is downloaded into
# $RUNNER_TEMP, its detached PGP signature is checked against the AWS CLI
# Team key committed beside this script, and it installs under $RUNNER_TEMP
# with no root access. Nothing here reads a secret.
#
# The key file is the public key published in the AWS CLI install guide
# (fingerprint below). It expires 2027-07-01; after that, verification fails
# here until the key file is replaced with the renewed one from that guide.
set -euo pipefail

AWS_CLI_VERSION="2.37.6"
AWS_CLI_KEY_FINGERPRINT="FB5DB77FD5C118B80511ADA8A6310ACC4672475C"
key_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/aws-cli-team-public-key.asc"

if command -v aws >/dev/null 2>&1 && aws --version 2>&1 | grep -q '^aws-cli/2\.'; then
  echo "AWS CLI v2 already on PATH: $(aws --version 2>&1)"
  exit 0
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is not set}"
: "${GITHUB_PATH:?GITHUB_PATH is not set}"
if [ "$(uname -s)" != "Linux" ]; then
  echo "install-aws-cli.sh installs the Linux build only; this runner is $(uname -s)" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64 | arm64) arch=aarch64 ;;
  x86_64 | amd64) arch=x86_64 ;;
  *)
    echo "No AWS CLI v2 build for machine architecture $(uname -m)" >&2
    exit 1
    ;;
esac
for tool in curl gpg unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required to install and verify the AWS CLI" >&2
    exit 1
  fi
done
if [ ! -f "$key_file" ]; then
  echo "AWS CLI signing key file is missing: $key_file" >&2
  exit 1
fi

work="$RUNNER_TEMP/aws-cli-download"
prefix="$RUNNER_TEMP/aws-cli"
bin_dir="$RUNNER_TEMP/aws-cli-bin"
rm -rf "$work" "$prefix" "$bin_dir"
mkdir -p "$work"

url="https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWS_CLI_VERSION}.zip"
curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  --output "$work/awscliv2.zip" "$url"
curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  --output "$work/awscliv2.sig" "$url.sig"

# A throwaway keyring: a persistent self-hosted runner's own keyring is never
# read or changed, and only the committed key can satisfy the check. It sits
# under /tmp because gpg's agent socket path has a short length limit that a
# deep runner work directory can exceed.
export GNUPGHOME
GNUPGHOME="$(mktemp -d /tmp/ave-aws-gpg.XXXXXX)"
trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
gpg --batch --quiet --import "$key_file"
imported="$(gpg --batch --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')"
if [ "$imported" != "$AWS_CLI_KEY_FINGERPRINT" ]; then
  echo "Committed AWS CLI key has fingerprint ${imported:-<none>}, expected $AWS_CLI_KEY_FINGERPRINT" >&2
  exit 1
fi
status="$(gpg --batch --status-fd 1 --verify "$work/awscliv2.sig" "$work/awscliv2.zip" 2>/dev/null)" || {
  echo "AWS CLI $AWS_CLI_VERSION ($arch) signature verification failed" >&2
  exit 1
}
# GOODSIG excludes a signature from an expired or revoked key; VALIDSIG names
# the signing key, which is the committed primary key or one of its subkeys.
if ! grep -q '^\[GNUPG:\] GOODSIG ' <<<"$status" \
  || ! grep -Eq "^\[GNUPG:\] VALIDSIG .*${AWS_CLI_KEY_FINGERPRINT}( |\$)" <<<"$status"; then
  echo "AWS CLI $AWS_CLI_VERSION ($arch) is not signed by $AWS_CLI_KEY_FINGERPRINT" >&2
  exit 1
fi
echo "Verified AWS CLI $AWS_CLI_VERSION ($arch) signature from $AWS_CLI_KEY_FINGERPRINT"

unzip -q "$work/awscliv2.zip" -d "$work"
"$work/aws/install" --install-dir "$prefix" --bin-dir "$bin_dir"
"$bin_dir/aws" --version
echo "$bin_dir" >> "$GITHUB_PATH"
rm -rf "$work"
