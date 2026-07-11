# Operator Guide

## Tool choice

- Use `interpret_architecture` for incomplete, mixed-format, or exploratory definitions.
- Use `price_architecture` when you need component-level costs, coverage, assumptions, or scenario
  comparison.
- Use `generate_calculator_link` when the user wants an official saved estimate and the complete
  in-scope graph is exact-link eligible.
- Use `list_service_catalog` to inspect resolver identifiers, supported regions, and serializer
  coverage.

## Input pattern

```json
{
  "sources": [
    {
      "id": "infrastructure",
      "formatHint": "terraform",
      "content": {
        "resource": {
          "aws_s3_bucket": {
            "assets": { "bucket": "example-assets" }
          },
          "aws_cloudfront_distribution": {
            "cdn": { "enabled": true }
          }
        }
      }
    },
    {
      "id": "requirements",
      "formatHint": "natural-language",
      "content": "Route 53 fronts the CDN. Exclude Lambda and API Gateway."
    }
  ],
  "context": {
    "name": "Public site",
    "region": "us-east-1",
    "targetMonthlyUsd": 1200
  }
}
```

Explicit context wins over inferred context. Conflicting explicit facts remain in `conflicts` and
must be resolved rather than being silently overwritten.

## Reading interpretation results

Inspect:

- `components[*].resolution.status`, candidates, rationale, confidence, and provenance;
- `components[*].inclusion` for included, excluded, and uncertain resources;
- component `quantity`, `configuration`, `usage`, `region`, and `environment`;
- `relationships` and their source evidence;
- `constraints`, `assumptions`, `conflicts`, and `unresolved`;
- prioritized `questions`;
- overall `coverage`.

An unknown AWS resource must remain in the graph with an open service ID. Never replace it with a
nearby supported service simply to make an estimate eligible.

## Reading pricing results

Inspect:

- `componentPlans[*].status`, cost, line items, warnings, and assumption IDs;
- `coverage.pricedComponentCount` and `coverage.unpricedComponentIds`;
- `eligibility.eligible`, `eligibility.blockers`, and ineligible component IDs;
- `lineItemPlan`, which is the immutable source for exact estimate construction;
- `questions` for missing region, budget, usage, quantity, or service resolution.

Explicit per-component configuration and budgets take precedence. When a current serializer still
requires compatibility sizing from a budget, every inferred field is recorded as an assumption.

## Exact-link rules

- Every included component must be resolved.
- Every resolved component must have exact serializer coverage in its region.
- No component may be silently omitted from the line-item plan.
- All blocking configuration and target-fit questions must be resolved.
- The selected scenario policy must support an exact link.
- The saved estimate must match the expected name, total, service count, and service signatures
  after it is fetched back from AWS.

Partial pricing is useful, but a partial estimate must never be described as the complete
architecture.

## Worker configuration

Required bindings and variables:

- `CHAT_STATE` Cloudflare KV namespace
- `CHAT_COORDINATOR` Durable Object binding
- `GEMINI_API_KEY` Worker secret
- `GEMINI_MODEL`
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`
- `CLOUDFLARE_ACCESS_AUD`
- optional `CLOUDFLARE_ACCESS_ISSUER`
- optional `CLOUDFLARE_ACCESS_JWKS_URL`

Routes:

- `GET /`: authenticated service metadata
- `GET /health`: authenticated health payload
- `GET /chat`: Gemini chat workspace
- `GET /api/me`: current Access identity
- `GET /api/chats`: owned and shared chat summaries
- `GET /api/chats/:chatId`: visible transcript and ACL data
- `POST /api/chats`: create a chat
- `POST /api/chats/:chatId/messages`: continue an owner-controlled thread
- `POST /api/chats/:chatId/shares`: share with one user
- `DELETE /api/chats/:chatId/shares/:email`: revoke access
- `POST /api/chats/:chatId/fork`: clone a readable chat
- `POST /mcp`: streamable HTTP MCP endpoint

Every route requires a valid Cloudflare Access assertion. Shared chats are read-only for non-owners;
collaborators must fork before continuing a thread.

## Service coverage

The runtime loads AWS Calculator's published manifest and registers every active definition for
discovery and resolution. The current live audit contains 430 active definitions. Of all 436
published entries, 426 are handled by the generic definition compiler, three specialized active
definitions are adapter-backed (EC2, EBS, and Windows Workloads), six are inactive, and one is a
non-configurable strings bundle.

Run `npm run coverage:live` to refresh and audit the full published surface. The command fails if an
active definition is missing from discovery, cannot be classified, fails closed during schema
loading, or requires an adapter that is not installed. Treat `list_service_catalog` as the runtime
source of truth; the [compatibility matrix](SERVICE_COMPATIBILITY_MATRIX.md) documents the
handwritten, parity-tested adapters that supplement the definition-driven surface.
