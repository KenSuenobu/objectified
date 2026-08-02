#!/usr/bin/env bash
# Container image entrypoint for bare CI recipes (CTG-2.4 / #4474).
#
# Passes every argument straight through to the apiome CLI after validating the
# credentials a pipeline supplies as masked/secured variables. This is what makes
# the diff-action image usable outside GitHub Actions — GitLab CI, Bitbucket
# Pipelines, or a plain docker run:
#
#   docker run --rm \
#     -e APIOME_API_KEY -e APIOME_TENANT_ID -e APIOME_BASE_URL \
#     -v "$PWD:/work" -w /work \
#     ghcr.io/apiome/diff-action:latest \
#     diff ./openapi.yaml --against payments-api@latest --fail-on breaking --format md
#
# Exit codes are the CLI's, so the gate stays readable:
#   0 = gate passed, 1 = threshold met, 2 = operational error.
# Credential/usage problems here exit 2 (never 1), so a misconfigured pipeline is
# never mistaken for a breaking change.
#
# Env:
#   APIOME_API_KEY    required (except for help/version invocations)
#   APIOME_TENANT_ID  required (except for help/version invocations)
#   APIOME_BASE_URL   optional, defaults to https://api.apiome.dev
#   APIOME_LOAD_DOTENV optional, defaults to 0 (ignore a checked-in .env)
#   APIOME_BIN        optional, CLI binary to exec — override in tests

set -uo pipefail

APIOME_BIN="${APIOME_BIN:-apiome}"

# Operational-error exit code shared with the CLI (auth/usage/network).
readonly EXIT_OPERATIONAL=2

# Print an operational error and exit 2.
#
# Args: $* — message shown on stderr.
die() {
  echo "apiome-ci: $*" >&2
  exit "${EXIT_OPERATIONAL}"
}

if [[ $# -eq 0 ]]; then
  die "no arguments given — usage: <apiome-command> [args…]" \
    "(e.g. diff ./openapi.yaml --against payments-api@latest --fail-on breaking)"
fi

# Tolerate `docker run <image> apiome diff …` — the binary name is implied here,
# and repeating it would otherwise become `apiome apiome diff`.
if [[ "${1}" == "apiome" ]]; then
  shift
  if [[ $# -eq 0 ]]; then
    die "no apiome command given after 'apiome' — try: diff ./openapi.yaml --against payments-api@latest"
  fi
fi

# Help and version never reach the API, so they must not demand credentials.
needs_credentials=true
case "${1}" in
  -h | --help | --version | help) needs_credentials=false ;;
esac

if [[ "${needs_credentials}" == "true" ]]; then
  if [[ -z "${APIOME_API_KEY:-}" ]]; then
    die "APIOME_API_KEY is not set — add it as a masked/secured CI variable"
  fi
  if [[ -z "${APIOME_TENANT_ID:-}" ]]; then
    die "APIOME_TENANT_ID is not set — add it as a masked/secured CI variable"
  fi
fi

export APIOME_BASE_URL="${APIOME_BASE_URL:-https://api.apiome.dev}"
# A checked-out repository may carry a committed .env; CI variables must win.
export APIOME_LOAD_DOTENV="${APIOME_LOAD_DOTENV:-0}"

exec "${APIOME_BIN}" "$@"
