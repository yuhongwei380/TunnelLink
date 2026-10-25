#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"
OPENVPN3_BIN_PATH="$PROJECT_ROOT/native/bin/macos/ovpncli"
npm ci
if [[ "${SKIP_OPENVPN3_BUILD:-0}" != "1" ]]; then
  if [[ "${FORCE_OPENVPN3_BUILD:-0}" == "1" ]] || ! node build/openvpn3-release.mjs "$OPENVPN3_BIN_PATH"; then
    bash build/macos/build-openvpn3.sh
  fi
fi
node build/openvpn3-release.mjs "$OPENVPN3_BIN_PATH"
node build/macos/verify-runtime.mjs "$OPENVPN3_BIN_PATH"
npm run dist:mac
printf '%s\n' "Tauri DMG installers: $PROJECT_ROOT/build/dist"
