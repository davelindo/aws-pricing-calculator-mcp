#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

CONFIG_FILE="${WRANGLER_CONFIG:-$ROOT_DIR/wrangler.toml}"
WORKER_NAME="${WORKER_NAME:-aws-pricing-calculator-mcp}"
WORKER_ENV="${WORKER_ENV:-}"

if [[ -z "${NPM_CONFIG_CACHE:-}" ]]; then
  export NPM_CONFIG_CACHE="${TMPDIR:-/tmp}/aws-pricing-calculator-mcp-npm-cache"
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to deploy the Cloudflare Worker." >&2
  exit 1
fi

WRANGLER_BASE=(npx wrangler --config "$CONFIG_FILE")

if [[ -n "$WORKER_ENV" ]]; then
  WRANGLER_BASE+=(--env "$WORKER_ENV")
fi

echo "Deploying Cloudflare Worker '$WORKER_NAME' using $CONFIG_FILE"

"${WRANGLER_BASE[@]}" deploy --name "$WORKER_NAME"

echo
echo "Deployment complete."
echo "Expected MCP endpoint:"
echo "  https://${WORKER_NAME}.workers.dev/mcp"
echo
echo "Health endpoint:"
echo "  https://${WORKER_NAME}.workers.dev/health"
