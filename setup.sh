#!/usr/bin/env bash
#
# Interactive setup for Apiome development environment files.
# Prompts for shared infrastructure values once, then writes .env files for
# each package based on its .env.example templates.
#
# Usage:
#   ./setup.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
else
  BOLD='' DIM='' GREEN='' YELLOW='' CYAN='' RESET=''
fi

info()  { printf '%b\n' "${CYAN}$*${RESET}"; }
warn()  { printf '%b\n' "${YELLOW}$*${RESET}" >&2; }
ok()    { printf '%b\n' "${GREEN}$*${RESET}"; }

prompt() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="${3-}"
  local input

  if [[ -n "$default_value" ]]; then
    printf '%b%s %b[%s]%b: ' "$BOLD" "$prompt_text" "$DIM" "$default_value" "$RESET"
  else
    printf '%b%s%b: ' "$BOLD" "$prompt_text" "$RESET"
  fi

  read -r input
  if [[ -z "$input" ]]; then
    input="$default_value"
  fi

  printf -v "$var_name" '%s' "$input"
}

prompt_secret() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="${3-}"
  local input

  if [[ -n "$default_value" ]]; then
    printf '%b%s %b[hidden; Enter keeps default]%b: ' "$BOLD" "$prompt_text" "$DIM" "$RESET"
  else
    printf '%b%s %b[hidden]%b: ' "$BOLD" "$prompt_text" "$DIM" "$RESET"
  fi

  read -rs input
  printf '\n'
  if [[ -z "$input" && -n "$default_value" ]]; then
    input="$default_value"
  fi

  printf -v "$var_name" '%s' "$input"
}

prompt_yes_no() {
  local var_name="$1"
  local prompt_text="$2"
  local default_yes="${3:-y}"
  local suffix input answer

  if [[ "$default_yes" == "y" ]]; then
    suffix="Y/n"
  else
    suffix="y/N"
  fi

  printf '%b%s %b[%s]%b: ' "$BOLD" "$prompt_text" "$DIM" "$suffix" "$RESET"
  read -r input

  if [[ -z "$input" ]]; then
    input="$default_yes"
  fi

  case "${input,,}" in
    y|yes) answer=true ;;
    *) answer=false ;;
  esac

  printf -v "$var_name" '%s' "$answer"
}

generate_secret() {
  local length="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$length" | tr -d '\n/+='
  else
    # Fallback when openssl is unavailable
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$length"
  fi
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

# Quote .env values when they contain characters that need escaping.
format_env_value() {
  local val="$1"
  if [[ "$val" =~ [[:space:]#=\"\$\\] ]]; then
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    val="${val//\$/\\\$}"
    printf '"%s"' "$val"
  else
    printf '%s' "$val"
  fi
}

should_write_file() {
  local target="$1"
  if [[ ! -f "$target" ]]; then
    return 0
  fi

  warn "File already exists: $target"
  prompt_yes_no overwrite "Overwrite?" "n"
  [[ "$overwrite" == true ]]
}

write_file() {
  local target="$1"
  local tmp

  mkdir -p "$(dirname "$target")"
  tmp="$(mktemp)"
  cat >"$tmp"
  mv "$tmp" "$target"
  ok "  wrote $target"
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

printf '\n'
info "Apiome environment setup"
info "This script creates .env files for local development."
printf '\n'

# ---------------------------------------------------------------------------
# Deployment mode
# ---------------------------------------------------------------------------
# The mode is a single config switch (development | production) that selects
# sensible defaults for the environment-specific settings below — REST
# auto-reload and the UI beta indicator. Every value remains overridable at its
# own prompt; the mode only changes what the default is.

info "Deployment mode"
while true; do
  prompt APP_MODE "Mode (development/production)" "development"
  case "${APP_MODE,,}" in
    dev|develop|development) APP_MODE="development"; break ;;
    prod|production)         APP_MODE="production";  break ;;
    *) warn "Please enter 'development' or 'production'." ;;
  esac
done

if [[ "$APP_MODE" == "production" ]]; then
  DEFAULT_REST_RELOAD="False"   # no auto-reload in production
  DEFAULT_BETA_MODE="false"     # hide the beta indicator in production
  ok "  production mode: auto-reload off, beta indicator off (defaults)"
else
  DEFAULT_REST_RELOAD="True"    # auto-reload while developing
  DEFAULT_BETA_MODE="true"      # show the beta indicator while developing
  ok "  development mode: auto-reload on, beta indicator on (defaults)"
fi

# ---------------------------------------------------------------------------
# Shared infrastructure
# ---------------------------------------------------------------------------

info "Database (shared by apiome-rest, apiome-ui, apiome-mcp, apiome-mock, apiome-browse)"
prompt POSTGRES_HOST "PostgreSQL host" "localhost"
prompt POSTGRES_PORT "PostgreSQL port" "5432"
prompt POSTGRES_USER "PostgreSQL user" "postgres"

while true; do
  prompt_secret POSTGRES_PASSWORD "PostgreSQL password"
  if [[ -n "$POSTGRES_PASSWORD" ]]; then
    break
  fi
  warn "Password is required."
done

prompt POSTGRES_DB "PostgreSQL database name" "apiome"

ENCODED_PASSWORD="$(urlencode "$POSTGRES_PASSWORD")"
DATABASE_URL="postgresql://${POSTGRES_USER}:${ENCODED_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"

printf '\n'
info "Authentication secret (must match across apiome-rest and apiome-ui)"
DEFAULT_NEXTAUTH_SECRET="$(generate_secret 32)"
prompt_yes_no use_generated_secret "Generate NEXTAUTH_SECRET automatically?" "y"
if [[ "$use_generated_secret" == true ]]; then
  NEXTAUTH_SECRET="$DEFAULT_NEXTAUTH_SECRET"
  ok "  generated NEXTAUTH_SECRET"
else
  while true; do
    prompt_secret NEXTAUTH_SECRET "NEXTAUTH_SECRET"
    if [[ -n "$NEXTAUTH_SECRET" ]]; then
      break
    fi
    warn "NEXTAUTH_SECRET is required."
  done
fi

printf '\n'
info "REST API (apiome-rest)"
prompt REST_HOST "REST API bind host" "0.0.0.0"
prompt REST_PORT "REST API port" "8000"
prompt REST_RELOAD "Enable auto-reload (True/False)" "$DEFAULT_REST_RELOAD"
DEFAULT_REST_BASE_URL="http://localhost:${REST_PORT}/v1"
prompt NEXT_PUBLIC_REST_API_BASE_URL "REST API base URL (client-facing)" "$DEFAULT_REST_BASE_URL"
# The UI calls the REST API under the "/v1" prefix, so ensure the base URL ends with it.
NEXT_PUBLIC_REST_API_BASE_URL="${NEXT_PUBLIC_REST_API_BASE_URL%/}"
if [[ "$NEXT_PUBLIC_REST_API_BASE_URL" != */v1 ]]; then
  NEXT_PUBLIC_REST_API_BASE_URL="${NEXT_PUBLIC_REST_API_BASE_URL}/v1"
fi
DEFAULT_APIOME_BASE_URL="http://localhost:${REST_PORT}"
prompt APIOME_BASE_URL "CLI REST base URL (no /v1 suffix)" "$DEFAULT_APIOME_BASE_URL"

printf '\n'
info "UI (apiome-ui)"
prompt UI_PORT "UI dev server port" "3000"
DEFAULT_NEXTAUTH_URL="http://localhost:${UI_PORT}"
prompt NEXTAUTH_URL "App site URL (OAuth redirect base)" "$DEFAULT_NEXTAUTH_URL"

while true; do
  prompt_secret ADMIN_PASSWORD "Super admin password (ADMIN_PASSWORD)"
  if [[ -n "$ADMIN_PASSWORD" ]]; then
    break
  fi
  warn "ADMIN_PASSWORD is required for the super admin portal."
done

DEFAULT_BROWSE_URL="http://localhost:3001"
prompt NEXT_PUBLIC_BROWSE_URL "Public browse app URL (apiome-browse)" "$DEFAULT_BROWSE_URL"
prompt OLLAMA_BASE_URL "Ollama LLM server URL" "http://localhost:11434"
prompt NEXT_PUBLIC_BETA_MODE "Enable beta mode indicator (true/false)" "$DEFAULT_BETA_MODE"

printf '\n'
info "MCP (apiome-mcp)"
DEFAULT_MCP_SECRET="$(generate_secret 24)"
prompt_yes_no use_generated_mcp_secret "Generate APIOME_MCP_INTERNAL_SECRET automatically?" "y"
if [[ "$use_generated_mcp_secret" == true ]]; then
  APIOME_MCP_INTERNAL_SECRET="$DEFAULT_MCP_SECRET"
  ok "  generated APIOME_MCP_INTERNAL_SECRET (min 16 characters)"
else
  while true; do
    prompt_secret APIOME_MCP_INTERNAL_SECRET "APIOME_MCP_INTERNAL_SECRET (min 16 characters)"
    if [[ ${#APIOME_MCP_INTERNAL_SECRET} -ge 16 ]]; then
      break
    fi
    warn "Secret must be at least 16 characters."
  done
fi
prompt APIOME_MCP_HTTP_PORT "MCP HTTP port (docker compose)" "8765"

printf '\n'
info "Mock runtime (apiome-mock)"
prompt APIOME_MOCK_HTTP_PORT "Mock HTTP port" "8775"
DEFAULT_APIOME_MOCK_PUBLIC_BASE_URL="http://localhost:${APIOME_MOCK_HTTP_PORT}"
prompt APIOME_MOCK_PUBLIC_BASE_URL "Mock public base URL (browser-reachable)" "$DEFAULT_APIOME_MOCK_PUBLIC_BASE_URL"

printf '\n'
info "Browse app (apiome-browse)"
prompt NEXT_PUBLIC_BASE_PATH "Base path for sub-path hosting (leave empty for root)" ""

printf '\n'
info "OAuth providers (optional — required only for GitHub/GitLab sign-in)"
prompt_yes_no configure_github "Configure GitHub OAuth?" "n"
if [[ "$configure_github" == true ]]; then
  prompt GITHUB_ID "GitHub OAuth client ID"
  prompt_secret GITHUB_SECRET "GitHub OAuth client secret"
else
  GITHUB_ID=""
  GITHUB_SECRET=""
fi

prompt_yes_no configure_gitlab "Configure GitLab OAuth?" "n"
if [[ "$configure_gitlab" == true ]]; then
  prompt GITLAB_CLIENT_ID "GitLab OAuth application ID"
  prompt_secret GITLAB_CLIENT_SECRET "GitLab OAuth client secret"
else
  GITLAB_CLIENT_ID=""
  GITLAB_CLIENT_SECRET=""
fi

printf '\n'
info "CLI credentials (optional — configure later with \`apiome config set\`)"
prompt APIOME_TENANT_ID "Tenant ID (UUID)" ""
prompt_secret APIOME_API_KEY "API key" ""
prompt_secret APIOME_SESSION_TOKEN "Session bearer token" ""

# ---------------------------------------------------------------------------
# Write files
# ---------------------------------------------------------------------------

printf '\n'
info "Writing environment files..."
CREATED=0
SKIPPED=0

write_rest_env() {
  local target="$ROOT/apiome-rest/.env"
  should_write_file "$target" || { ((SKIPPED++)) || true; return; }

  write_file "$target" <<EOF
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ") (mode: $APP_MODE)

# Database configuration
DATABASE_URL=$(format_env_value "$DATABASE_URL")

# Server configuration
HOST=$(format_env_value "$REST_HOST")
PORT=$(format_env_value "$REST_PORT")
RELOAD=$(format_env_value "$REST_RELOAD")

# JWT Authentication (must match apiome-ui NEXTAUTH_SECRET)
NEXTAUTH_SECRET=$(format_env_value "$NEXTAUTH_SECRET")

# Public mock runtime URL (must match apiome-ui and apiome-browse)
APIOME_MOCK_PUBLIC_BASE_URL=$(format_env_value "$APIOME_MOCK_PUBLIC_BASE_URL")
EOF
  ((CREATED++)) || true
}

write_ui_env() {
  local target="$ROOT/apiome-ui/.env"
  should_write_file "$target" || { ((SKIPPED++)) || true; return; }

  {
    cat <<EOF
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ") (mode: $APP_MODE)

# Node environment (development | production) — follows the deployment mode
NODE_ENV=$(format_env_value "$APP_MODE")

# REST API Base URL (must start with NEXT_PUBLIC_ for client-side access)
NEXT_PUBLIC_REST_API_BASE_URL=$(format_env_value "$NEXT_PUBLIC_REST_API_BASE_URL")

# PostgreSQL — same database as apiome-rest
DATABASE_URL=$(format_env_value "$DATABASE_URL")

# Public API browser (apiome-browse)
NEXT_PUBLIC_BROWSE_URL=$(format_env_value "$NEXT_PUBLIC_BROWSE_URL")
NEXTAUTH_URL=$(format_env_value "$NEXTAUTH_URL")
NEXTAUTH_SECRET=$(format_env_value "$NEXTAUTH_SECRET")

# Beta Mode - Set to any value to enable beta indicator on login screen
NEXT_PUBLIC_BETA_MODE=$(format_env_value "$NEXT_PUBLIC_BETA_MODE")

# Admin password for super admin site
ADMIN_PASSWORD=$(format_env_value "$ADMIN_PASSWORD")

# Ollama LLM Server URL for AI-powered import feature
OLLAMA_BASE_URL=$(format_env_value "$OLLAMA_BASE_URL")

# Public mock runtime URL (must match apiome-rest and apiome-browse)
APIOME_MOCK_PUBLIC_BASE_URL=$(format_env_value "$APIOME_MOCK_PUBLIC_BASE_URL")
EOF
    if [[ "$configure_github" == true ]]; then
      cat <<EOF

# GitHub OAuth
GITHUB_ID=$(format_env_value "$GITHUB_ID")
GITHUB_SECRET=$(format_env_value "$GITHUB_SECRET")
EOF
    fi
    if [[ "$configure_gitlab" == true ]]; then
      cat <<EOF

# GitLab OAuth
GITLAB_CLIENT_ID=$(format_env_value "$GITLAB_CLIENT_ID")
GITLAB_CLIENT_SECRET=$(format_env_value "$GITLAB_CLIENT_SECRET")
EOF
    fi
  } | write_file "$target"
  ((CREATED++)) || true
}

write_mcp_env() {
  local target="$ROOT/apiome-mcp/.env"
  should_write_file "$target" || { ((SKIPPED++)) || true; return; }

  write_file "$target" <<EOF
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Required
APIOME_MCP_DATABASE_URL=$(format_env_value "$DATABASE_URL")
APIOME_MCP_INTERNAL_SECRET=$(format_env_value "$APIOME_MCP_INTERNAL_SECRET")

# Optional HTTP bind (used with --transport http or docker compose)
APIOME_MCP_HTTP_HOST=127.0.0.1
APIOME_MCP_HTTP_PORT=$(format_env_value "$APIOME_MCP_HTTP_PORT")
EOF
  ((CREATED++)) || true
}

write_mock_env() {
  local target="$ROOT/apiome-mock/.env"
  should_write_file "$target" || { ((SKIPPED++)) || true; return; }

  write_file "$target" <<EOF
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Required
APIOME_MOCK_DATABASE_URL=$(format_env_value "$DATABASE_URL")

# Optional HTTP bind
APIOME_MOCK_HTTP_HOST=127.0.0.1
APIOME_MOCK_HTTP_PORT=$(format_env_value "$APIOME_MOCK_HTTP_PORT")
EOF
  ((CREATED++)) || true
}

write_cli_env() {
  local target="$ROOT/apiome-cli/.env"
  should_write_file "$target" || { ((SKIPPED++)) || true; return; }

  {
    cat <<EOF
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Base URL for the Apiome REST API
APIOME_BASE_URL=$(format_env_value "$APIOME_BASE_URL")
APIOME_TENANT_ID=$(format_env_value "$APIOME_TENANT_ID")
APIOME_API_KEY=$(format_env_value "$APIOME_API_KEY")
APIOME_SESSION_TOKEN=$(format_env_value "$APIOME_SESSION_TOKEN")
EOF
  } | write_file "$target"
  ((CREATED++)) || true
}

write_browse_env() {
  local target="$ROOT/apiome-browse/.env.local"
  should_write_file "$target" || { ((SKIPPED++)) || true; return; }

  write_file "$target" <<EOF
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Database configuration
DATABASE_URL=$(format_env_value "$DATABASE_URL")
POSTGRES_USER=$(format_env_value "$POSTGRES_USER")
POSTGRES_HOST=$(format_env_value "$POSTGRES_HOST")
POSTGRES_DB=$(format_env_value "$POSTGRES_DB")
POSTGRES_PASSWORD=$(format_env_value "$POSTGRES_PASSWORD")
POSTGRES_PORT=$(format_env_value "$POSTGRES_PORT")

# REST API Base URL (for fetching specifications)
NEXT_PUBLIC_REST_API_BASE_URL=$(format_env_value "$NEXT_PUBLIC_REST_API_BASE_URL")

# Base path for sub-path hosting (optional)
NEXT_PUBLIC_BASE_PATH=$(format_env_value "$NEXT_PUBLIC_BASE_PATH")

# Public mock runtime URL (must match apiome-rest and apiome-ui)
APIOME_MOCK_PUBLIC_BASE_URL=$(format_env_value "$APIOME_MOCK_PUBLIC_BASE_URL")
EOF
  ((CREATED++)) || true
}

write_compose_env() {
  local target="$ROOT/.env"
  should_write_file "$target" || { ((SKIPPED++)) || true; return; }

  write_file "$target" <<EOF
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Used by docker compose at the repository root.

POSTGRES_USER=$(format_env_value "$POSTGRES_USER")
POSTGRES_PASSWORD=$(format_env_value "$POSTGRES_PASSWORD")
POSTGRES_DB=$(format_env_value "$POSTGRES_DB")
POSTGRES_PUBLISH_PORT=$(format_env_value "$POSTGRES_PORT")

APIOME_MCP_HTTP_PORT=$(format_env_value "$APIOME_MCP_HTTP_PORT")
APIOME_MCP_INTERNAL_SECRET=$(format_env_value "$APIOME_MCP_INTERNAL_SECRET")

APIOME_MOCK_HTTP_PORT=$(format_env_value "$APIOME_MOCK_HTTP_PORT")
APIOME_MOCK_PUBLIC_BASE_URL=$(format_env_value "$APIOME_MOCK_PUBLIC_BASE_URL")
EOF
  ((CREATED++)) || true
}

write_rest_env
write_ui_env
write_mcp_env
write_mock_env
write_cli_env
write_browse_env
write_compose_env

printf '\n'
ok "Setup complete: ${CREATED} file(s) written, ${SKIPPED} skipped (mode: ${APP_MODE})."
printf '\n'
info "Next steps:"
printf '  1. Ensure PostgreSQL is running and create the database if needed:\n'
printf '       psql -U %s -h %s -p %s -c "CREATE DATABASE %s;"\n' \
  "$POSTGRES_USER" "$POSTGRES_HOST" "$POSTGRES_PORT" "$POSTGRES_DB"
printf '  2. Run migrations: cd apiome-db && apiome-db migrate\n'
if [[ "$APP_MODE" == "production" ]]; then
  printf '  3. Build and start the stack: yarn install && yarn build && yarn start\n'
else
  printf '  3. Start the stack: yarn install && yarn dev\n'
fi
printf '\n'
