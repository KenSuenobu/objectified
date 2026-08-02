#!/usr/bin/env bash
# Shared helpers for the CTG-2.4 (#4474) CI recipe smoke tests.
#
# Parses the small, fixed YAML subset used by diff-action/recipes/*: a `script:`
# block of shell lines and (GitLab only) a `variables:` block of scalar env vars.
# This is deliberately not a general YAML parser — the recipes must stay simple
# enough that someone copy-pasting them understands them at a glance, and this
# parser fails loudly (empty output -> failing assertions) if they stop being so.
#
# Source it: . "$(dirname "$0")/recipe_lib.sh"

# Strip one layer of YAML quoting from a scalar.
#
# Args: $1 — raw scalar, possibly wrapped in '…' or "…".
# Stdout: the unquoted value ('' inside single quotes collapses to ').
yaml_unquote() {
  local value="$1"
  if [[ ${#value} -ge 2 && "${value}" == \'*\' ]]; then
    value="${value:1:${#value}-2}"
    value="${value//\'\'/\'}"
  elif [[ ${#value} -ge 2 && "${value}" == \"*\" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s\n' "${value}"
}

# Print the raw list items of every `<key>:` block in a recipe.
#
# Args: $1 — recipe file, $2 — block key (`script` or `variables`).
# Stdout: one entry per line, YAML list dashes removed, indentation stripped.
_recipe_block_entries() {
  local file="$1"
  local key="$2"
  awk -v key="${key}" '
    $0 ~ "^[[:space:]]*" key ":[[:space:]]*$" {
      inblk = 1
      ind = match($0, /[^ ]/)
      next
    }
    inblk == 1 {
      if ($0 ~ /^[[:space:]]*$/) { next }
      cur = match($0, /[^ ]/)
      if (cur <= ind) { inblk = 0; next }
      line = $0
      sub(/^[[:space:]]*/, "", line)
      print line
    }
  ' "${file}"
}

# Print the shell commands of a recipe, one per line, ready to execute.
#
# Args: $1 — recipe file.
# Stdout: unquoted shell lines from every `script:` block.
recipe_script_lines() {
  local file="$1"
  local entry
  while IFS= read -r entry; do
    [[ "${entry}" == -\ * ]] || continue
    yaml_unquote "${entry#- }"
  done < <(_recipe_block_entries "${file}" script)
}

# Print `export KEY=VALUE` lines for a recipe's `variables:` block.
#
# Args: $1 — recipe file.
# Stdout: shell-quoted export statements (empty when the recipe has no block).
recipe_variable_exports() {
  local file="$1"
  local entry key value
  while IFS= read -r entry; do
    [[ "${entry}" == *:\ * ]] || continue
    key="${entry%%:*}"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="$(yaml_unquote "${entry#*: }")"
    printf 'export %s=%q\n' "${key}" "${value}"
  done < <(_recipe_block_entries "${file}" variables)
}

# Materialise a recipe as a runnable shell script.
#
# GitLab and Bitbucket both abort the job on the first failing command, so the
# generated script runs under `set -e` to mirror that behaviour faithfully.
#
# Args: $1 — recipe file, $2 — destination script path.
# Returns: 0; writes the script to $2.
recipe_to_shell() {
  local file="$1"
  local dest="$2"
  {
    echo "#!/usr/bin/env bash"
    echo "set -e"
    recipe_variable_exports "${file}"
    recipe_script_lines "${file}"
  } >"${dest}"
  chmod +x "${dest}"
}

# Extract the fenced code block that follows a marker line in a document.
#
# Args: $1 — markdown file, $2 — exact marker line (e.g. `<!-- recipe:gitlab -->`).
# Stdout: the block's contents, without the fences.
doc_fenced_block() {
  local doc="$1"
  local marker="$2"
  awk -v marker="${marker}" '
    $0 == marker { found = 1; next }
    found && infence == 0 && /^```/ { infence = 1; next }
    found && infence == 1 && /^```/ { exit }
    found && infence == 1 { print }
  ' "${doc}"
}
