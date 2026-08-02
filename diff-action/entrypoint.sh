#!/usr/bin/env bash
# GitHub Action entrypoint for apiome/diff-action (CTG-2.2 / #4472).
# Runs `apiome diff --format md`, upserts a sticky PR comment, then exits with
# the CLI exit code (0 = pass, 1 = gate failed, 2 = operational error).

set -uo pipefail

APIOME_BIN="${APIOME_BIN:-apiome}"
STICKY_BIN="${STICKY_BIN:-sticky_comment.sh}"
CI_ENTRYPOINT="${CI_ENTRYPOINT:-ci_entrypoint.sh}"

# Dual mode (CTG-2.4 / #4474): the GitHub Action runs this image with no
# arguments and configures everything through INPUT_* env vars. Any argument
# means the image was run as a plain CLI wrapper by a GitLab/Bitbucket recipe or
# `docker run`, so hand off to the pass-through entrypoint.
if [[ $# -gt 0 ]]; then
  exec "${CI_ENTRYPOINT}" "$@"
fi
WORKSPACE="${GITHUB_WORKSPACE:-.}"
CHANGELOG_REL="${APIOME_CHANGELOG_PATH:-.apiome-diff-changelog.md}"
CHANGELOG_PATH="${WORKSPACE%/}/${CHANGELOG_REL#./}"

SPEC="${INPUT_SPEC:-}"
PROJECT="${INPUT_PROJECT:-}"
FAIL_ON="${INPUT_FAIL_ON:-breaking}"
API_KEY="${INPUT_API_KEY:-}"
TENANT="${INPUT_TENANT:-}"
BASE_URL="${INPUT_BASE_URL:-https://api.apiome.dev}"
COMMENT="${INPUT_COMMENT:-true}"
GITHUB_TOKEN="${INPUT_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"

log() {
  echo "$*" >&2
}

write_output() {
  local name="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      echo "${name}=${value}"
    } >>"${GITHUB_OUTPUT}"
  fi
}

resolve_pr_number() {
  if [[ -n "${PR_NUMBER:-}" ]]; then
    echo "${PR_NUMBER}"
    return 0
  fi
  if [[ -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
    jq -r '
      .pull_request.number // .issue.number // empty
    ' "${GITHUB_EVENT_PATH}" 2>/dev/null || true
  fi
}

if [[ -z "${SPEC}" ]]; then
  echo "::error::Input 'spec' is required"
  exit 2
fi
if [[ -z "${PROJECT}" ]]; then
  echo "::error::Input 'project' is required"
  exit 2
fi
if [[ -z "${API_KEY}" ]]; then
  echo "::error::Input 'api-key' is required"
  exit 2
fi
if [[ -z "${TENANT}" ]]; then
  echo "::error::Input 'tenant' is required"
  exit 2
fi

case "${FAIL_ON}" in
  breaking|warn) ;;
  *)
    echo "::error::Input 'fail-on' must be 'breaking' or 'warn' (got: ${FAIL_ON})"
    exit 2
    ;;
esac

cd "${WORKSPACE}"

SPEC_PATH="${SPEC}"
if [[ ! -f "${SPEC_PATH}" ]]; then
  echo "::error::Spec file not found: ${SPEC_PATH}"
  exit 2
fi

export APIOME_API_KEY="${API_KEY}"
export APIOME_TENANT_ID="${TENANT}"
export APIOME_BASE_URL="${BASE_URL}"
export APIOME_LOAD_DOTENV="${APIOME_LOAD_DOTENV:-0}"

log "Running: ${APIOME_BIN} diff ${SPEC_PATH} --against ${PROJECT} --fail-on ${FAIL_ON} --format md"

ERR_PATH="$(mktemp)"
set +e
"${APIOME_BIN}" diff "${SPEC_PATH}" \
  --against "${PROJECT}" \
  --fail-on "${FAIL_ON}" \
  --format md \
  >"${CHANGELOG_PATH}" 2>"${ERR_PATH}"
DIFF_EXIT=$?
set -e
if [[ -s "${ERR_PATH}" ]]; then
  cat "${ERR_PATH}" >&2
fi
rm -f "${ERR_PATH}"

# Also echo changelog to the job log for reviewers who skip the PR comment.
if [[ -s "${CHANGELOG_PATH}" ]]; then
  log "----- apiome diff changelog (md) -----"
  cat "${CHANGELOG_PATH}" >&2 || true
  log "----- end changelog -----"
fi

write_output "exit-code" "${DIFF_EXIT}"
write_output "changelog-path" "${CHANGELOG_REL}"

HEADER=""
case "${DIFF_EXIT}" in
  0) HEADER="### Apiome contract gate: passed" ;;
  1) HEADER="### Apiome contract gate: failed (threshold: \`${FAIL_ON}\`)" ;;
  2)
    echo "::error::Apiome diff operational error (exit 2)"
    HEADER="### Apiome contract gate: error"
    ;;
  *)
    echo "::error::Apiome diff unexpected exit code ${DIFF_EXIT}"
    HEADER="### Apiome contract gate: unexpected exit \`${DIFF_EXIT}\`"
    ;;
esac

COMMENT_BODY_PATH="$(mktemp)"
{
  echo "<!-- apiome-diff-action -->"
  echo "${HEADER}"
  echo
  echo "Compared \`${SPEC_PATH}\` against \`${PROJECT}\`."
  echo
  if [[ -s "${CHANGELOG_PATH}" ]]; then
    cat "${CHANGELOG_PATH}"
  else
    echo "_No changelog output._"
  fi
} >"${COMMENT_BODY_PATH}"

should_comment=false
case "$(echo "${COMMENT}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes) should_comment=true ;;
esac

PR_NUM="$(resolve_pr_number)"
EVENT_NAME="${GITHUB_EVENT_NAME:-}"

if [[ "${should_comment}" == "true" ]]; then
  if [[ -n "${PR_NUM}" ]]; then
    export GITHUB_TOKEN
    export PR_NUMBER="${PR_NUM}"
    set +e
    "${STICKY_BIN}" "${COMMENT_BODY_PATH}"
    STICKY_EXIT=$?
    set -e
    if [[ "${STICKY_EXIT}" -ne 0 ]]; then
      log "warning: sticky PR comment failed (exit ${STICKY_EXIT}); continuing with diff exit ${DIFF_EXIT}"
    fi
  else
    log "sticky comment skipped (no pull request number; event=${EVENT_NAME:-unknown})"
  fi
else
  log "sticky comment disabled (comment=${COMMENT})"
fi

rm -f "${COMMENT_BODY_PATH}"
exit "${DIFF_EXIT}"
