#!/usr/bin/env bash
# Run all diff-action shell tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

chmod +x entrypoint.sh ci_entrypoint.sh sticky_comment.sh tests/*.sh 2>/dev/null || true

fail=0
for t in tests/test_*.sh; do
  echo "==> ${t}"
  if bash "${t}"; then
    echo "OK ${t}"
  else
    echo "FAIL ${t}" >&2
    fail=1
  fi
done

if [[ "${fail}" -ne 0 ]]; then
  echo "diff-action tests failed" >&2
  exit 1
fi
echo "All diff-action tests passed"
