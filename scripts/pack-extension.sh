#!/usr/bin/env bash
# Package extension/ into a zip named for the version in its manifest.
#
# The extension has no build step — the folder Chrome loads is the folder in
# git — so packaging is only ever "zip the source, minus the things Chrome
# would choke on or that leak a machine's local state".
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' extension/manifest.json | head -1)
if [ -z "$version" ]; then
  echo "could not read version from extension/manifest.json" >&2
  exit 1
fi

out="dist/jobcopilot-${version}.zip"
mkdir -p dist
rm -f "$out"

# -x excludes: macOS metadata and editor droppings have no business in a
# package that gets loaded as a Chrome extension.
( cd extension && zip -qr "../${out}" . \
    -x '.DS_Store' -x '__MACOSX/*' -x '._*' -x '*.map' )

echo "$out"
