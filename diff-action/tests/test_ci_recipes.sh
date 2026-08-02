#!/usr/bin/env bash
# Smoke tests for the GitLab CI / Bitbucket Pipelines recipes (CTG-2.4 / #4474).
#
# The recipes are executed the way the runners execute them: the `variables:` and
# `script:` blocks are extracted from the YAML and run under `set -e` inside a
# throw-away workspace, against a stub `apiome` binary that reports a chosen exit
# code. That keeps the recipes honest (a renamed variable or a broken redirect
# fails here) without needing a GitLab or Bitbucket runner.
#
# Usage: test_ci_recipes.sh [--recipe gitlab|bitbucket|all]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${ROOT}/.." && pwd)"
DOC="${REPO_ROOT}/docs/guide/ci-gitlab-bitbucket.md"

# shellcheck source=diff-action/tests/recipe_lib.sh
. "${ROOT}/tests/recipe_lib.sh"

SELECTED="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --recipe)
      SELECTED="${2:?--recipe needs a value}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

BIN="${TMP}/bin"
mkdir -p "${BIN}"
export PATH="${BIN}:${PATH}"

EXPECTED_ARGS="diff openapi.yaml --against payments-api@latest --fail-on breaking --format md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Install a stub `apiome` that logs its invocation and exits with a chosen code.
#
# Args: $1 — exit code the stub returns.
install_stub() {
  local code="$1"
  cat >"${BIN}/apiome" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"\${APIOME_ARGS_LOG}"
env | grep -E '^APIOME_(BASE_URL|LOAD_DOTENV|TENANT_ID|API_KEY)=' | sort >>"\${APIOME_ENV_LOG}"
echo "# Apiome changelog (stub exit ${code})"
exit ${code}
EOF
  chmod +x "${BIN}/apiome"
}

# Run a generated recipe script in a clean workspace.
#
# Args: $1 — script path, $2 — workspace path, $3 — API key, $4 — tenant.
# Env in:  APIOME_ARGS_LOG / APIOME_ENV_LOG must be set by the caller.
# Stdout: the script's combined output; returns the script's exit code.
run_recipe() {
  local script="$1"
  local workspace="$2"
  local key="$3"
  local tenant="$4"
  (
    cd "${workspace}"
    export APIOME_API_KEY="${key}"
    export APIOME_TENANT_ID="${tenant}"
    "${script}" 2>&1
  )
}

# Prepare a fresh workspace containing a candidate spec.
#
# Stdout: the workspace path.
new_workspace() {
  local dir
  dir="$(mktemp -d "${TMP}/ws.XXXXXX")"
  printf 'openapi: 3.1.0\n' >"${dir}/openapi.yaml"
  printf '%s\n' "${dir}"
}

# Assert a recipe propagates the CLI exit code and captures the changelog.
#
# Args: $1 — generated script, $2 — expected/stub exit code.
assert_exit_code_case() {
  local script="$1"
  local code="$2"
  local workspace out actual
  workspace="$(new_workspace)"
  install_stub "${code}"
  export APIOME_ARGS_LOG="${workspace}/args.log"
  export APIOME_ENV_LOG="${workspace}/env.log"
  : >"${APIOME_ARGS_LOG}"
  : >"${APIOME_ENV_LOG}"

  set +e
  out="$(run_recipe "${script}" "${workspace}" "test-key" "acme-corp")"
  actual=$?
  set -e

  [[ "${actual}" -eq "${code}" ]] ||
    fail "expected exit ${code}, got ${actual}: ${out}"
  grep -qxF "${EXPECTED_ARGS}" "${APIOME_ARGS_LOG}" ||
    fail "unexpected CLI arguments: $(cat "${APIOME_ARGS_LOG}")"
  grep -qxF "APIOME_BASE_URL=https://api.apiome.dev" "${APIOME_ENV_LOG}" ||
    fail "recipe did not pass APIOME_BASE_URL to the CLI"
  grep -qxF "APIOME_LOAD_DOTENV=0" "${APIOME_ENV_LOG}" ||
    fail "recipe did not disable dotenv loading"
  grep -qxF "APIOME_TENANT_ID=acme-corp" "${APIOME_ENV_LOG}" ||
    fail "recipe did not pass APIOME_TENANT_ID to the CLI"
  [[ -s "${workspace}/apiome-changelog.md" ]] ||
    fail "recipe did not write apiome-changelog.md"
  grep -q "Apiome changelog (stub exit ${code})" "${workspace}/apiome-changelog.md" ||
    fail "changelog artifact does not hold the CLI markdown output"
  grep -q "Apiome changelog (stub exit ${code})" <<<"${out}" ||
    fail "recipe did not echo the changelog into the job log"
}

# Assert a recipe fails fast (exit 2) when a required credential is missing.
#
# Args: $1 — generated script, $2 — name of the variable to leave unset.
assert_missing_credential_case() {
  local script="$1"
  local missing="$2"
  local workspace out actual
  workspace="$(new_workspace)"
  install_stub 0
  export APIOME_ARGS_LOG="${workspace}/args.log"
  export APIOME_ENV_LOG="${workspace}/env.log"
  : >"${APIOME_ARGS_LOG}"
  : >"${APIOME_ENV_LOG}"

  local key="test-key" tenant="acme-corp"
  case "${missing}" in
    APIOME_API_KEY) key="" ;;
    APIOME_TENANT_ID) tenant="" ;;
    *) fail "unknown credential ${missing}" ;;
  esac

  set +e
  out="$(run_recipe "${script}" "${workspace}" "${key}" "${tenant}")"
  actual=$?
  set -e

  [[ "${actual}" -eq 2 ]] ||
    fail "missing ${missing}: expected exit 2, got ${actual}: ${out}"
  grep -q "${missing} is not set" <<<"${out}" ||
    fail "missing ${missing}: expected an explanatory message, got: ${out}"
  [[ ! -s "${APIOME_ARGS_LOG}" ]] ||
    fail "missing ${missing}: the CLI must not run"
}

# Assert the guide embeds the canonical recipe byte-for-byte (anti-rot).
#
# Args: $1 — recipe file, $2 — marker line in the guide.
assert_doc_matches_recipe() {
  local recipe="$1"
  local marker="$2"
  [[ -f "${DOC}" ]] || fail "guide not found: ${DOC}"
  local extracted="${TMP}/doc-block.yml"
  doc_fenced_block "${DOC}" "${marker}" >"${extracted}"
  [[ -s "${extracted}" ]] || fail "no fenced block after marker ${marker} in ${DOC}"
  diff -u "${extracted}" "${recipe}" ||
    fail "the guide block after ${marker} has drifted from ${recipe}"
}

# Run every assertion for one recipe.
#
# Args: $1 — recipe name (gitlab|bitbucket), $2 — recipe file, $3 — doc marker.
check_recipe() {
  local name="$1"
  local recipe="$2"
  local marker="$3"
  echo "==> recipe: ${name}"

  [[ -f "${recipe}" ]] || fail "recipe not found: ${recipe}"
  grep -q "ghcr.io/apiome/diff-action" "${recipe}" ||
    fail "${name}: recipe must run the diff-action container image"

  local script="${TMP}/${name}.sh"
  recipe_to_shell "${recipe}" "${script}"
  local line_count
  line_count="$(recipe_script_lines "${recipe}" | wc -l)"
  [[ "${line_count}" -ge 3 ]] ||
    fail "${name}: expected the recipe script block to parse (got ${line_count} lines)"

  assert_exit_code_case "${script}" 0
  assert_exit_code_case "${script}" 1
  assert_exit_code_case "${script}" 2
  assert_missing_credential_case "${script}" APIOME_API_KEY
  assert_missing_credential_case "${script}" APIOME_TENANT_ID
  assert_doc_matches_recipe "${recipe}" "${marker}"

  echo "OK  recipe: ${name}"
}

run_gitlab() {
  local recipe="${ROOT}/recipes/.gitlab-ci.yml"
  grep -q 'entrypoint: \[""\]' "${recipe}" ||
    fail "gitlab: the job must clear the image entrypoint so GitLab can run a shell"
  check_recipe "gitlab" "${recipe}" "<!-- recipe:gitlab -->"
}

run_bitbucket() {
  local recipe="${ROOT}/recipes/bitbucket-pipelines.yml"
  grep -q "pull-requests:" "${recipe}" ||
    fail "bitbucket: the pipeline must be wired to pull requests"
  check_recipe "bitbucket" "${recipe}" "<!-- recipe:bitbucket -->"
}

case "${SELECTED}" in
  gitlab) run_gitlab ;;
  bitbucket) run_bitbucket ;;
  all)
    run_gitlab
    run_bitbucket
    ;;
  *)
    echo "unknown recipe: ${SELECTED} (expected gitlab, bitbucket, or all)" >&2
    exit 2
    ;;
esac

echo "test_ci_recipes: ok (${SELECTED})"
