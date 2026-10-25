#!/usr/bin/env bash
# The published Trust Index from a fetched trust-data commit into <dir>: index/ (meta.json and the parts,
# lib/index-files.js), or index.json from a commit before the parts. Scripts read either with --index <dir>/index.json.
#
#   git fetch --depth 1 origin trust-data && bash scripts/trust-index-get.sh FETCH_HEAD trust-data
set -euo pipefail
ref="$1"
dir="$2"
mkdir -p "$dir"
if git cat-file -e "$ref:index/meta.json" 2>/dev/null; then
  rm -rf "$dir/index"
  git archive --format=tar "$ref" index | tar -x -C "$dir"
  echo "trust index: $(ls "$dir/index" | grep -c '\.ndjson$') parts"
else
  git show "$ref:index.json" > "$dir/index.json"
  echo "trust index: index.json"
fi
