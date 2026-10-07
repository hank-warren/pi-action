#!/usr/bin/env bash
# Install the pinned pi CLI globally and the CLIProxyAPI provider extension into
# $RUNNER_TEMP/pi-ext, where runner.mjs expects it (PI_ACTION_EXTENSION_DIR).
set -euo pipefail
: "${PI_VERSION:?}" "${PROVIDER_EXTENSION_VERSION:?}" "${RUNNER_TEMP:?}"
npm install -g --no-fund --no-audit "@earendil-works/pi-coding-agent@${PI_VERSION}"
mkdir -p "${RUNNER_TEMP}/pi-ext"
npm install --prefix "${RUNNER_TEMP}/pi-ext" --no-fund --no-audit --no-save \
  "@hank-warren/pi-cliproxyapi-provider@${PROVIDER_EXTENSION_VERSION}"
