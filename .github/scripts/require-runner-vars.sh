#!/usr/bin/env bash
# Fails the job, naming the variable, when a repo variable that chooses a
# release job's runner is unset or malformed. Each argument is the name of an
# environment variable the step maps from `vars.<NAME>`.
#
# An unset runner variable must not fall back to a GitHub-hosted label: hosted
# minutes are billing-blocked for this repo, and that failure says nothing
# about which variable is missing. Running on hosted runners is still an
# explicit choice: set the variable to the hosted label, as a JSON string or
# label array, e.g. "macos-15" or ["windows-latest"].
#
# A self-hosted value is a JSON label array, e.g.
# ["self-hosted","macOS","ARM64","ave-release"].
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: require-runner-vars.sh <VAR_NAME>..." >&2
  exit 2
fi

missing=0
for name in "$@"; do
  value="${!name:-}"
  if [ -z "$value" ]; then
    echo "::error::Repository variable $name is not set. Set it to the runner's JSON label array, e.g. [\"self-hosted\",\"Linux\",\"ARM64\",\"ave\"], or opt into a GitHub-hosted runner by naming its label, e.g. \"ubuntu-24.04-arm\"."
    missing=1
    continue
  fi
  if ! RUNNER_VALUE="$value" node -e '
    const value = JSON.parse(process.env.RUNNER_VALUE);
    const labels = typeof value === "string" ? [value] : value;
    const valid = Array.isArray(labels) && labels.length > 0
      && labels.every((label) => typeof label === "string" && label.trim() !== "");
    process.exit(valid ? 0 : 1);
  ' 2>/dev/null; then
    echo "::error::Repository variable $name must be a JSON label string or a non-empty JSON array of label strings; got: $value"
    missing=1
    continue
  fi
  echo "$name = $value"
done
exit "$missing"
