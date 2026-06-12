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

if grep -q "replace-with-" "$CONFIG_FILE"; then
  echo "Refusing to deploy: $CONFIG_FILE still contains placeholder values." >&2
  exit 1
fi

if ! grep -q 'binding = "CHAT_STATE"' "$CONFIG_FILE"; then
  cat >&2 <<EOF
Refusing to deploy: $CONFIG_FILE has no CHAT_STATE KV binding.

Create a KV namespace, add a [[kv_namespaces]] block for CHAT_STATE to your
deployment config, and provision these Worker settings before deploying:
  - GEMINI_API_KEY as a Worker secret
  - CLOUDFLARE_ACCESS_TEAM_DOMAIN
  - CLOUDFLARE_ACCESS_AUD
  - optional CLOUDFLARE_ACCESS_ISSUER
  - optional CLOUDFLARE_ACCESS_JWKS_URL
EOF
  exit 1
fi

if ! grep -q 'name = "CHAT_COORDINATOR"' "$CONFIG_FILE"; then
  cat >&2 <<EOF
Refusing to deploy: $CONFIG_FILE has no CHAT_COORDINATOR Durable Object binding.

Add the ChatCoordinator Durable Object binding and migration before deploying
the Worker chat API. Chat mutations are coordinated through this Durable Object
to avoid KV read-modify-write races.
EOF
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
echo "Expected service endpoints:"
echo "  https://${WORKER_NAME}.workers.dev/"
echo "  https://${WORKER_NAME}.workers.dev/chat"
echo "  https://${WORKER_NAME}.workers.dev/mcp"
echo
echo "Health endpoint:"
echo "  https://${WORKER_NAME}.workers.dev/health"
echo
echo "Remote auth model: Cloudflare Access"
echo "  Configure CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUD before deploy."
echo "  The Worker expects Cf-Access-Jwt-Assertion on every route, including /mcp."
echo
echo "Required bindings:"
echo "  - CHAT_STATE KV namespace"
echo "  - GEMINI_API_KEY secret"
