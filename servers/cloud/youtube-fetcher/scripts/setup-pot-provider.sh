#!/usr/bin/env bash
# YouTube's media servers require a proof-of-origin token. The yt-dlp plugin
# that requests one ships on PyPI (bgutil-ytdlp-pot-provider, in
# requirements.txt), but the code that actually mints the token is a Node
# project distributed only on GitHub — so it is built here rather than pinned
# as a dependency.
#
# The plugin looks for the built script at a fixed path under $HOME, which is
# why that location is not configurable below. Re-run this after recreating
# the machine or container the fetcher runs on; nothing else needs it.
#
#   ./scripts/setup-pot-provider.sh
#
# Requires node and git. Without it, metadata resolves and every download
# fails with "HTTP Error 403: Forbidden", which looks like a network fault.
set -euo pipefail

REPO="https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git"
# The commit tagged 1.3.1, the version of the bgutil-ytdlp-pot-provider plugin
# pinned in requirements.txt; bump the two together. A commit, not a tag or a
# branch, because those can be moved to other code, and this script builds and
# runs whatever it's given.
COMMIT="7608dd51ee813b48cf9a6d68c6e42cb197ce10e0"
HOME_DIR="${HOME}/bgutil-ytdlp-pot-provider"
BUILT="${HOME_DIR}/server/build/generate_once.js"

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v git  >/dev/null || { echo "git is required"  >&2; exit 1; }

if [ ! -d "${HOME_DIR}/.git" ]; then
  rm -rf "${HOME_DIR}"
  git init --quiet "${HOME_DIR}"
fi
echo "Fetching the token provider at ${COMMIT:0:12}…"
git -C "${HOME_DIR}" fetch --depth 1 --quiet "${REPO}" "${COMMIT}"
git -C "${HOME_DIR}" checkout --quiet --force --detach FETCH_HEAD
git -C "${HOME_DIR}" clean -fdxq
[ "$(git -C "${HOME_DIR}" rev-parse HEAD)" = "${COMMIT}" ] ||
  { echo "fetched the wrong commit" >&2; exit 1; }

echo "Building…"
cd "${HOME_DIR}/server"
# ci installs exactly what the provider's package-lock.json lists, checking
# each package against the hash recorded there.
npm ci --no-audit --no-fund --silent
npx tsc

[ -f "${BUILT}" ] || { echo "build produced no ${BUILT}" >&2; exit 1; }
echo "Ready: ${BUILT}"
