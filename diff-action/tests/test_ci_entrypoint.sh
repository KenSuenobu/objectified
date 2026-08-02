#!/usr/bin/env bash
# Unit tests for ci_entrypoint.sh — the container image's CLI pass-through mode
# (CTG-2.4 / #4474) — and for entrypoint.sh dispatching to it when given args.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

BIN="${TMP}/bin"
mkdir -p "${BIN}"
export APIOME_BIN="${BIN}/apiome"
export APIOME_ARGS_LOG="${TMP}/args.log"
export APIOME_ENV_LOG="${TMP}/env.log"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Install a stub CLI that records how it was called and exits with a given code.
#
# Args: $1 — exit code the stub returns.
install_stub() {
  local code="$1"
  cat >"${APIOME_BIN}" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"\${APIOME_ARGS_LOG}"
env | grep -E '^APIOME_(BASE_URL|LOAD_DOTENV)=' | sort >>"\${APIOME_ENV_LOG}"
echo "stub stdout"
exit ${code}
EOF
  chmod +x "${APIOME_BIN}"
}

# Run ci_entrypoint.sh with a clean log state.
#
# Args: $@ — arguments forwarded to the entrypoint.
# Stdout: combined output; returns the entrypoint's exit code.
run_ci() {
  : >"${APIOME_ARGS_LOG}"
  : >"${APIOME_ENV_LOG}"
  bash "${ROOT}/ci_entrypoint.sh" "$@" 2>&1
}

install_stub 0
export APIOME_API_KEY="test-key"
export APIOME_TENANT_ID="acme-corp"

# --- arguments are passed through verbatim -----------------------------------
set +e
out="$(run_ci diff ./openapi.yaml --against payments-api@latest --fail-on breaking --format md)"
code=$?
set -e
[[ "${code}" -eq 0 ]] || fail "pass-through: expected exit 0, got ${code}: ${out}"
grep -qxF "diff ./openapi.yaml --against payments-api@latest --fail-on breaking --format md" \
  "${APIOME_ARGS_LOG}" || fail "pass-through: arguments were altered: $(cat "${APIOME_ARGS_LOG}")"

# --- defaults applied for base URL and dotenv --------------------------------
grep -qxF "APIOME_BASE_URL=https://api.apiome.dev" "${APIOME_ENV_LOG}" ||
  fail "defaults: APIOME_BASE_URL not defaulted"
grep -qxF "APIOME_LOAD_DOTENV=0" "${APIOME_ENV_LOG}" ||
  fail "defaults: APIOME_LOAD_DOTENV not defaulted to 0"

# --- explicit env is preserved ------------------------------------------------
(
  export APIOME_BASE_URL="https://apiome.internal"
  export APIOME_LOAD_DOTENV=1
  run_ci diff spec.yaml >/dev/null 2>&1
)
grep -qxF "APIOME_BASE_URL=https://apiome.internal" "${APIOME_ENV_LOG}" ||
  fail "explicit env: APIOME_BASE_URL was overwritten"
grep -qxF "APIOME_LOAD_DOTENV=1" "${APIOME_ENV_LOG}" ||
  fail "explicit env: APIOME_LOAD_DOTENV was overwritten"

# --- CLI exit codes propagate unchanged --------------------------------------
for expected in 0 1 2; do
  install_stub "${expected}"
  set +e
  out="$(run_ci diff spec.yaml --against p@latest)"
  code=$?
  set -e
  [[ "${code}" -eq "${expected}" ]] ||
    fail "exit codes: expected ${expected}, got ${code}: ${out}"
done
install_stub 0

# --- missing credentials fail fast with exit 2 -------------------------------
set +e
out="$(APIOME_API_KEY="" run_ci diff spec.yaml --against p@latest)"
code=$?
set -e
[[ "${code}" -eq 2 ]] || fail "missing key: expected exit 2, got ${code}: ${out}"
grep -q "APIOME_API_KEY is not set" <<<"${out}" || fail "missing key: unhelpful message: ${out}"
[[ ! -s "${APIOME_ARGS_LOG}" ]] || fail "missing key: the CLI must not run"

set +e
out="$(APIOME_TENANT_ID="" run_ci diff spec.yaml --against p@latest)"
code=$?
set -e
[[ "${code}" -eq 2 ]] || fail "missing tenant: expected exit 2, got ${code}: ${out}"
grep -q "APIOME_TENANT_ID is not set" <<<"${out}" || fail "missing tenant: unhelpful message: ${out}"
[[ ! -s "${APIOME_ARGS_LOG}" ]] || fail "missing tenant: the CLI must not run"

# --- help and version need no credentials ------------------------------------
for helper in --help -h --version help; do
  set +e
  out="$(APIOME_API_KEY="" APIOME_TENANT_ID="" run_ci "${helper}")"
  code=$?
  set -e
  [[ "${code}" -eq 0 ]] || fail "${helper}: expected exit 0, got ${code}: ${out}"
  grep -qxF -e "${helper}" "${APIOME_ARGS_LOG}" || fail "${helper}: not forwarded to the CLI"
done

# --- a repeated `apiome` binary name is tolerated ----------------------------
set +e
out="$(run_ci apiome diff spec.yaml --against p@latest)"
code=$?
set -e
[[ "${code}" -eq 0 ]] || fail "repeated binary: expected exit 0, got ${code}: ${out}"
grep -qxF "diff spec.yaml --against p@latest" "${APIOME_ARGS_LOG}" ||
  fail "repeated binary: expected the duplicate name to be dropped: $(cat "${APIOME_ARGS_LOG}")"

set +e
out="$(run_ci apiome)"
code=$?
set -e
[[ "${code}" -eq 2 ]] || fail "bare binary name: expected exit 2, got ${code}: ${out}"
grep -q "no apiome command given" <<<"${out}" || fail "bare binary name: unhelpful message: ${out}"

# --- no arguments is a usage error, not a gate failure -----------------------
set +e
out="$(run_ci)"
code=$?
set -e
[[ "${code}" -eq 2 ]] || fail "no args: expected exit 2, got ${code}: ${out}"
grep -q "no arguments given" <<<"${out}" || fail "no args: unhelpful message: ${out}"

# --- entrypoint.sh delegates to the CI entrypoint when given arguments -------
install_stub 1
: >"${APIOME_ARGS_LOG}"
: >"${APIOME_ENV_LOG}"
set +e
out="$(CI_ENTRYPOINT="${ROOT}/ci_entrypoint.sh" \
  bash "${ROOT}/entrypoint.sh" diff spec.yaml --against p@latest 2>&1)"
code=$?
set -e
[[ "${code}" -eq 1 ]] || fail "dispatch: expected the CLI exit code 1, got ${code}: ${out}"
grep -qxF "diff spec.yaml --against p@latest" "${APIOME_ARGS_LOG}" ||
  fail "dispatch: entrypoint.sh did not hand the arguments to ci_entrypoint.sh"
if grep -q "Input 'spec' is required" <<<"${out}"; then
  fail "dispatch: entrypoint.sh ran Action mode instead of delegating"
fi

echo "test_ci_entrypoint: ok"
