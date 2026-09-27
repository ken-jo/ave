#!/usr/bin/env bash
set -euo pipefail

repo="${1:?repository path required}"
commit="${2:?exact commit required}"
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::archive input must be an exact commit SHA" >&2
  exit 1
fi

# The explicit repository path must select the tree, even inside a Git hook.
for name in "${!GIT_@}"; do unset "$name"; done

inventory=$(mktemp)
trap 'rm -f "$inventory"' EXIT
if ! git -C "$repo" ls-tree -r -z "$commit" -- > "$inventory"; then
  echo "::error::$repo archive tree could not be enumerated" >&2
  exit 1
fi

count=0
while IFS= read -r -d '' entry; do
  count=$((count + 1))
  mode="${entry%% *}"
  case "$mode" in
    100644|100755|160000) ;;
    120000)
      echo "::error::$repo archive tree contains a symbolic-link entry" >&2
      exit 1
      ;;
    *)
      echo "::error::$repo archive tree has an invalid entry" >&2
      exit 1
      ;;
  esac
done < "$inventory"

if [ "$count" -eq 0 ]; then
  echo "::error::$repo archive tree inventory is empty" >&2
  exit 1
fi
