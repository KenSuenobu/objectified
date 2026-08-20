#!/usr/bin/env bash
# Install dev toolchain binaries into apiome-rest/.tools/bin (MFI-5.2, FMT-1.3).
#
# The production image bundles buf (and other CLIs) under /opt/apiome-tools/bin. Local
# `yarn dev` / run.sh uses this script so gRPC/Protobuf catalog import can compile .proto
# files without requiring a system-wide buf install.
#
# Two kinds of tool are installed:
#
#   buf              optional — its absence degrades gRPC/Protobuf import to "unavailable".
#   asyncapi-parser  REQUIRED (FMT-1.3, #5414) — the AsyncAPI adapter has no fallback parser,
#                    so a runtime without it loses a shipped format. Its exact version is
#                    pinned in toolchain/package.json (the toolchain manifest), which is what
#                    the container build and CI install from too.
#
# Usage:
#   ./scripts/install_dev_toolchain.sh [--force] [tool ...]
#
# With no tool named, everything above is installed. Name one or more (`buf`,
# `asyncapi-parser`) to install just those — CI uses that to add the required parser without
# re-downloading buf.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TOOLS_BIN="${ROOT}/.tools/bin"
BUF_BIN="${TOOLS_BIN}/buf"
FORCE=0

SELECTED=()

for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--force] [tool ...]

Installs the pinned buf binary and the required @asyncapi/parser toolchain into
apiome-rest/.tools/ for local gRPC/Protobuf and AsyncAPI import.
Run from the apiome-rest directory (or via ./run.sh / yarn dev).

  --force   Re-install even when a working tool is already present.
  tool      Install only the named tool(s): buf, asyncapi-parser. Default: all.
EOF
      exit 0
      ;;
    buf|asyncapi-parser) SELECTED+=("$arg") ;;
    *)
      echo "install_dev_toolchain: unknown argument '${arg}' (try --help)" >&2
      exit 1
      ;;
  esac
done

# Whether this run should install the named tool (no selection means "install everything").
wanted() {
  [[ ${#SELECTED[@]} -eq 0 ]] && return 0
  local tool
  for tool in "${SELECTED[@]}"; do
    [[ "$tool" == "$1" ]] && return 0
  done
  return 1
}

mkdir -p "$TOOLS_BIN"

buf_ok() {
  [[ -x "$BUF_BIN" ]] && "$BUF_BIN" --version >/dev/null 2>&1
}

install_buf() {
  if buf_ok && [[ "$FORCE" -eq 0 ]]; then
    echo "install_dev_toolchain: buf already installed at ${BUF_BIN} ($("$BUF_BIN" --version 2>/dev/null | head -1))"
    echo "install_dev_toolchain: restart the REST API if gRPC import still shows buf as unavailable."
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "install_dev_toolchain: curl is required to download buf" >&2
    exit 1
  fi

  # Pinned version — read from BUNDLED_TOOLS (single source of truth; no uv/python needed).
  BUF_VERSION="$(
    grep -E '^\s+key="buf"' -A5 src/app/toolchain_packaging.py \
      | grep -E 'version=' | head -1 \
      | sed -E 's/.*version="([^"]+)".*/\1/'
  )"
  if [[ -z "$BUF_VERSION" ]]; then
    echo "install_dev_toolchain: could not read buf version from src/app/toolchain_packaging.py" >&2
    exit 1
  fi

  OS="$(uname -s)"
  ARCH="$(uname -m)"
  case "${OS}" in
    Linux)
      BUF_OS=Linux
      case "${ARCH}" in
        x86_64) BUF_ARCH=x86_64 ;;
        aarch64|arm64) BUF_ARCH=aarch64 ;;
        *)
          echo "install_dev_toolchain: unsupported Linux architecture: ${ARCH}" >&2
          exit 1
          ;;
      esac
      ;;
    Darwin)
      BUF_OS=Darwin
      case "${ARCH}" in
        x86_64) BUF_ARCH=x86_64 ;;
        arm64) BUF_ARCH=arm64 ;;
        *)
          echo "install_dev_toolchain: unsupported macOS architecture: ${ARCH}" >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "install_dev_toolchain: unsupported OS: ${OS}" >&2
      exit 1
      ;;
  esac

  URL="https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-${BUF_OS}-${BUF_ARCH}"
  echo "install_dev_toolchain: downloading buf ${BUF_VERSION} (${BUF_OS}-${BUF_ARCH})"
  curl -fsSL "${URL}" -o "${BUF_BIN}.tmp"
  chmod +x "${BUF_BIN}.tmp"
  mv "${BUF_BIN}.tmp" "${BUF_BIN}"

  if ! buf_ok; then
    echo "install_dev_toolchain: download finished but '${BUF_BIN} --version' failed" >&2
    exit 1
  fi

  echo "install_dev_toolchain: installed ${BUF_BIN} ($("$BUF_BIN" --version 2>/dev/null | head -1))"
}

# ---------------------------------------------------------------------------------------
# asyncapi-parser — REQUIRED (FMT-1.3, #5414)
# ---------------------------------------------------------------------------------------
#
# `toolchain/asyncapi-parse.mjs` imports `@asyncapi/parser` by bare specifier, so it has to
# sit *beside* the installed node_modules (node resolves from the script's own realpath, which
# is why the script is copied rather than symlinked — exactly what the Dockerfile does). The
# wrapper on .tools/bin then makes it look like any other bundled binary to
# app.toolchain_runner.

NODE_PREFIX="${ROOT}/.tools/node"
PARSER_BIN="${TOOLS_BIN}/asyncapi-parser"

parser_ok() {
  [[ -x "$PARSER_BIN" ]] && "$PARSER_BIN" --version >/dev/null 2>&1
}

install_asyncapi_parser() {
  # Exact pin from the toolchain manifest — the single place the version is written for the
  # container build, CI and local dev alike.
  local pin
  pin="$(
    grep -E '"@asyncapi/parser"' toolchain/package.json \
      | sed -E 's/.*"@asyncapi\/parser"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
  )"
  if [[ -z "$pin" ]]; then
    echo "install_dev_toolchain: could not read the @asyncapi/parser pin from toolchain/package.json" >&2
    exit 1
  fi

  if parser_ok && [[ "$FORCE" -eq 0 ]] && "$PARSER_BIN" --version 2>/dev/null | grep -qF " ${pin}"; then
    echo "install_dev_toolchain: asyncapi-parser already installed at ${PARSER_BIN} ($("$PARSER_BIN" --version 2>/dev/null | head -1))"
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "install_dev_toolchain: npm is required to install @asyncapi/parser@${pin}." >&2
    echo "install_dev_toolchain: AsyncAPI import is a REQUIRED format — without it the service" >&2
    echo "install_dev_toolchain: refuses to start when APIOME_REQUIRE_TOOLCHAIN is on." >&2
    exit 1
  fi

  echo "install_dev_toolchain: installing @asyncapi/parser@${pin} into ${NODE_PREFIX}"
  mkdir -p "$NODE_PREFIX"
  npm install --prefix "$NODE_PREFIX" --no-audit --no-fund --silent "@asyncapi/parser@${pin}"
  cp "${ROOT}/toolchain/asyncapi-parse.mjs" "${NODE_PREFIX}/asyncapi-parse.mjs"
  chmod +x "${NODE_PREFIX}/asyncapi-parse.mjs"
  printf '#!/bin/sh\nexec node %s/asyncapi-parse.mjs "$@"\n' "$NODE_PREFIX" > "$PARSER_BIN"
  chmod +x "$PARSER_BIN"

  if ! parser_ok; then
    echo "install_dev_toolchain: install finished but '${PARSER_BIN} --version' failed" >&2
    exit 1
  fi
  echo "install_dev_toolchain: installed ${PARSER_BIN} ($("$PARSER_BIN" --version 2>/dev/null | head -1))"
}

if wanted buf; then
  install_buf
fi
if wanted asyncapi-parser; then
  install_asyncapi_parser
fi

echo "install_dev_toolchain: restart the REST API (yarn dev) if it is already running."
