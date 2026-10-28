#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENVPN3_REPO_URL="${OPENVPN3_REPO_URL:-https://github.com/OpenVPN/openvpn3.git}"
RELEASE_REF="$(node -p "require(process.argv[1]).ref" "$PROJECT_ROOT/resources/settings/openvpn3-release.json")"
RELEASE_COMMIT="$(node -p "require(process.argv[1]).commit" "$PROJECT_ROOT/resources/settings/openvpn3-release.json")"
OPENVPN3_REF="${OPENVPN3_REF:-$RELEASE_REF}"
[[ "$OPENVPN3_REF" == "$RELEASE_REF" ]] || { echo 'OPENVPN3_REF must match resources/settings/openvpn3-release.json' >&2; exit 1; }
OPENVPN3_KEEP_WORKDIR="${OPENVPN3_KEEP_WORKDIR:-0}"
JOBS="${OPENVPN3_BUILD_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
MACOS_DEPLOYMENT_TARGET="${OPENVPN3_MACOS_DEPLOYMENT_TARGET:-11.0}"

mkdir -p "$PROJECT_ROOT/.cache/work/macos"
WORKDIR="${OPENVPN3_WORKDIR:-$PROJECT_ROOT/.cache/work/macos/openvpn3-$RELEASE_COMMIT-$(uname -m)-$MACOS_DEPLOYMENT_TARGET}"
SRC_DIR="$WORKDIR/openvpn3"
BUILD_DIR="$WORKDIR/build-openvpn3"
OUTPUT_BIN="$PROJECT_ROOT/.cache/native/bin/macos/ovpncli"
OUTPUT_LIB_DIR="$PROJECT_ROOT/.cache/native/bin/macos/lib"

array_contains() {
  local needle="$1"
  shift || true
  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

is_third_party_dylib() {
  local dep="$1"
  if [[ "$dep" == /usr/lib/* || "$dep" == /System/Library/* ]]; then
    return 1
  fi
  if [[ "$dep" == /* ]]; then
    return 0
  fi
  return 1
}

list_dependencies() {
  # Keep paths containing spaces intact; ignore otool's image/architecture headers.
  otool -L "$1" | sed -n 's/^[[:space:]]*\(.*\) (compatibility version .*$/\1/p'
}

if [[ "${FORCE_OPENVPN3_BUILD:-0}" != "1" ]] && node "$PROJECT_ROOT/make/engine-cache.mjs" verify macos "$(uname -m)" Release; then
  node "$PROJECT_ROOT/make/macos/verify-runtime.mjs" "$OUTPUT_BIN"
  exit 0
fi

echo "[1/5] Checking build tools..."
command -v git >/dev/null
command -v cmake >/dev/null
command -v make >/dev/null
command -v otool >/dev/null
command -v install_name_tool >/dev/null
command -v node >/dev/null
command -v lipo >/dev/null

echo "[2/5] Checking cached OpenVPN3 source ($OPENVPN3_REF)..."
node "$PROJECT_ROOT/make/engine-cache.mjs" source "$WORKDIR" "$OPENVPN3_REPO_URL"
[[ "$(git -C "$SRC_DIR" rev-parse HEAD)" == "$RELEASE_COMMIT" ]] || { echo 'Fetched source does not match the pinned release commit.' >&2; exit 1; }

echo "[3/5] Configuring OpenVPN3 build..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"

echo "[4/5] Building ovpncli..."
build_args=(--build "$BUILD_DIR" --target ovpncli -j "$JOBS")
if [[ "${FORCE_OPENVPN3_BUILD:-0}" == "1" ]]; then build_args+=(--clean-first); fi
cmake "${build_args[@]}"

BUILT_BIN="$BUILD_DIR/test/ovpncli/ovpncli"
if [[ ! -f "$BUILT_BIN" ]]; then
  echo "ovpncli not found at expected path: $BUILT_BIN" >&2
  exit 1
fi

echo "[5/6] Installing ovpncli into .cache/native/bin/macos..."
mkdir -p "$(dirname "$OUTPUT_BIN")"
cp "$BUILT_BIN" "$OUTPUT_BIN"
chmod +x "$OUTPUT_BIN"

echo "[6/6] Bundling non-system dylib dependencies..."
mkdir -p "$OUTPUT_LIB_DIR"
rm -f "$OUTPUT_LIB_DIR"/*.dylib

deps=()
queue=("$BUILT_BIN")
idx=0
while [[ $idx -lt ${#queue[@]} ]]; do
  current="${queue[$idx]}"
  idx=$((idx + 1))
  while IFS= read -r dep; do
    [[ -z "$dep" ]] && continue
    if ! is_third_party_dylib "$dep"; then
      continue
    fi
    if [[ ! -f "$dep" ]]; then
      echo "Missing macOS runtime dependency: $dep (required by $current)" >&2
      exit 1
    fi
    if ! array_contains "$dep" "${deps[@]-}"; then
      deps+=("$dep")
      queue+=("$dep")
    fi
  done < <(list_dependencies "$current")
done

for dep in "${deps[@]}"; do
  base="$(basename "$dep")"
  cp -f "$dep" "$OUTPUT_LIB_DIR/$base"
  chmod 755 "$OUTPUT_LIB_DIR/$base"
done

for dep in "${deps[@]}"; do
  base="$(basename "$dep")"
  if list_dependencies "$OUTPUT_BIN" | grep -Fxq "$dep"; then
    install_name_tool -change "$dep" "@executable_path/lib/$base" "$OUTPUT_BIN"
  fi
done

for dep in "${deps[@]}"; do
  base="$(basename "$dep")"
  local_copy="$OUTPUT_LIB_DIR/$base"
  install_name_tool -id "@rpath/$base" "$local_copy"
  for sub_dep in "${deps[@]}"; do
    sub_base="$(basename "$sub_dep")"
    if list_dependencies "$local_copy" | grep -Fxq "$sub_dep"; then
      install_name_tool -change "$sub_dep" "@loader_path/$sub_base" "$local_copy"
    fi
  done
done

node "$PROJECT_ROOT/make/macos/verify-runtime.mjs" "$OUTPUT_BIN"
node "$PROJECT_ROOT/make/record-engine-build.mjs" "$SRC_DIR" "$OUTPUT_BIN" "$(uname -m)"

echo "Done. ovpncli available at: $OUTPUT_BIN"
echo "Source and compiler cache retained: $WORKDIR"
