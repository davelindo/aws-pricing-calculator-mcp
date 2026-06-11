# aws-pricing-calculator-mcp

![Version](https://img.shields.io/badge/version-4.0.0-2563eb)
![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20streamable--http-7c3aed)

`aws-pricing-calculator-mcp` is an MCP server for designing AWS architectures, pricing scenarios, creating official AWS Pricing Calculator share links, and validating the saved estimate. It runs locally over stdio and also ships a Cloudflare Worker that hosts the remote `streamable-http` endpoint plus an Access-protected Gemini chat workspace.

## What This Project Does

This project helps an MCP client turn an architecture brief or blueprint into:

- a normalized architecture design
- priced baseline, optimized, and aggressive scenarios
- an official `https://calculator.aws/#/estimate?id=...` share link
- validation results against what AWS actually saved

The server exposes these tools:

| Tool | Purpose |
| --- | --- |
| `list_blueprints` | Discover the supported blueprint catalog |
| `list_service_catalog` | Inspect service coverage and region support |
| `design_architecture` | Turn a brief or blueprint into a normalized architecture |
| `price_architecture` | Price one or more scenario policies |
| `generate_calculator_link` | Default one-shot path: design or price inputs, choose a scenario, create the official link, and validate it |
| `create_calculator_link` | Advanced path: commit a previously priced exact scenario, usually via its `pricingCommit` handle |
| `validate_calculator_link` | Fetch a saved estimate and validate it |

## Why It Is Useful

- It produces official AWS calculator links instead of local-only estimates.
- It supports blueprint-driven and brief-driven workflows, so agents can start from either a known pattern or rough input.
- It compares scenario policies explicitly, including commitment posture, HA posture, storage strategy, and shared-service overhead.
- It validates the saved estimate for pricing parity, architecture completeness, and governance signals.
- It ships exact coverage across six roadmap regions:
  `us-east-1`, `ca-central-1`, `sa-east-1`, `eu-west-1`, `ap-southeast-2`, `ap-northeast-2`.

Common blueprints include:

- `container-platform`
- `linux-web-stack`
- `windows-app-stack`
- `edge-api-platform`
- `event-driven-platform`
- `data-platform-lite`
- `modernization-platform`
- `enterprise-data-platform`

Use `list_service_catalog` to inspect the exact service-region matrix from the running server.

## Getting Started

### Prerequisites

- Node.js `>=18`
- npm
- network access to AWS calculator endpoints when creating links or running live parity tests

### Install

```bash
git clone https://github.com/<your-org>/aws-pricing-calculator-mcp.git
cd aws-pricing-calculator-mcp
npm install
npm run check
```

### Run Locally Over stdio

```bash
npm start
```

Or run the executable directly:

```bash
node bin/aws-pricing-calculator-mcp.js
```

### Run Remotely On The Cloudflare Worker

```bash
npm run worker:dev
```

Deploy the Cloudflare Worker:

```bash
npm run worker:deploy
```

The Worker now expects these bindings and vars:

- `CHAT_STATE` Cloudflare KV namespace
- `GEMINI_API_KEY` Worker secret
- `GEMINI_MODEL`
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`
- `CLOUDFLARE_ACCESS_AUD`
- optional `CLOUDFLARE_ACCESS_ISSUER`
- optional `CLOUDFLARE_ACCESS_JWKS_URL`

The hosted Worker is Access-only. Every route, including `/mcp`, expects a valid `Cf-Access-Jwt-Assertion`.

The Worker serves:

- `/` service info
- `/health` health info
- `/chat` the Gemini chat workspace
- `/mcp` the remote MCP endpoint

### Run The Gemini Chatbot In Docker

The repo also ships a very small Gemini-backed web chatbot that can call exactly two in-process tools:

- `generate_calculator_link`

Build it:

```bash
docker build -f Dockerfile.chatbot -t aws-pricing-chatbot .
```

Run it:

```bash
docker run --rm -p 3000:3000 \
  -e GEMINI_API_KEY=your-gemini-api-key \
  -e GEMINI_MODEL=gemini-2.5-flash \
  aws-pricing-chatbot
```

Then open `http://localhost:3000`.

### MCP Client Configuration

Example stdio configuration:

```json
{
  "mcpServers": {
    "aws-pricing-calculator": {
      "command": "node",
      "args": ["bin/aws-pricing-calculator-mcp.js"],
      "cwd": "/absolute/path/to/aws-pricing-calculator-mcp"
    }
  }
}
```

Example remote configuration:

```json
{
  "mcpServers": {
    "awsPricingCalculator": {
      "type": "streamable-http",
      "url": "https://<worker-name>.<account-subdomain>.workers.dev/mcp"
    }
  }
}
```

Remote MCP clients must be able to authenticate through Cloudflare Access because bearer-only `/mcp` access is no longer supported on the Worker host.

### Typical Workflow

1. Discover the blueprint catalog when the workload shape is still open.

```json
{}
```

Call `list_blueprints`.

2. Design from a brief when the input is still fuzzy.

```json
{
  "brief": "Need a 9k monthly edge API platform in eu-west-1 with CloudFront, Lambda, DynamoDB, Route53, and API Gateway."
}
```

Call `design_architecture`.

3. Use `generate_calculator_link` as the default one-shot path when the goal is “get me the official link now.”

```json
{
  "blueprintId": "edge-api-platform",
  "region": "eu-west-1",
  "targetMonthlyUsd": 9000
}
```

Call `generate_calculator_link`.

This prices the request, selects the scenario, saves the official AWS estimate, and returns inline validation for the saved result.

4. Use `price_architecture` when you want scenario comparison or a `pricingCommit` handle for advanced flows.

5. Use `create_calculator_link` when you already have a priced exact scenario and want to commit it explicitly.

Pass `pricingCommit` from `price_architecture` as the canonical input. `pricedScenario` is still accepted for compatibility.

6. Use `validate_calculator_link` later to re-validate a saved estimate by share link or estimate id.

```json
{
  "shareLinkOrEstimateId": "https://calculator.aws/#/estimate?id=<saved-estimate-id>",
  "blueprintId": "edge-api-platform",
  "expectedRegion": "eu-west-1"
}
```

Call `validate_calculator_link`.

### Useful Commands

```bash
npm run check
```

Runs lint, verifies the checked-in `v1` contract artifacts are current, and runs the test suite.

```bash
npm run contracts:generate
```

Regenerates the checked-in `v1` contract artifacts under `docs/contracts/v1/`.

```bash
npm run test:live
```

Runs the live save/fetch parity matrix against AWS calculator endpoints.

### Chat Workspace

The Worker-hosted chat workspace uses Gemini plus the in-process `generate_calculator_link` tool handler.

It stores chat history in Cloudflare KV, identifies users from Cloudflare Access, supports explicit email-based ACL sharing, and allows shared users to fork threads into their own private copies.

## Project Layout

| Path | Purpose |
| --- | --- |
| `src/access.js` | Cloudflare Access JWT validation and normalized user identity |
| `src/server.js` | MCP tool registration and schemas |
| `src/calculator-link-runtime.js` | shared calculator-link runtime used by MCP and the chatbot |
| `src/chatbot/` | Gemini orchestration, Worker chat routes, and KV-backed chat store |
| `src/worker.js` | Cloudflare Worker host for `/`, `/health`, `/chat`, `/api/*`, and `/mcp` |
| `public/chat/` | static Worker-served chat UI |
| `src/architecture.js` | architecture design, scenario pricing, exact link planning |
| `src/planner.js` | estimate construction helpers used by the MCP surface |
| `src/validation.js` | saved-estimate validation and policy checks |
| `src/services/` | service registry, serializers, and saved-cost modeling |
| `src/contract/v1.js` | frozen `v1` MCP contract definitions |
| `docs/contracts/v1/` | generated `v1` JSON schemas and emitted tool snapshot |
| `docs/OPERATOR_GUIDE.md` | operator-oriented usage notes |
| `test/live-roundtrip.test.js` | live parity matrix for exact coverage |

## v1 Compatibility

The `v1` MCP surface is frozen at these tool names:

- `list_blueprints`
- `list_service_catalog`
- `design_architecture`
- `price_architecture`
- `generate_calculator_link`
- `create_calculator_link`
- `validate_calculator_link`

Within `v1`, required top-level fields, stable enum literals, and structured tool-error responses are compatibility commitments. Additive optional fields are allowed. The checked-in source of truth for that contract lives under [docs/contracts/v1/](docs/contracts/v1/).

## Where To Get Help

- Read the operator guide: [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md)
- Check the example live coverage matrix: [test/live-roundtrip.test.js](test/live-roundtrip.test.js)
- Inspect tool input and output schemas in [src/server.js](src/server.js)
- If something looks wrong, open an issue or send a pull request with a failing test case

## Who Maintains And Contributes

This repository is maintained by the repository owner and contributors to `davelindo/aws-pricing-calculator-mcp`.

If you want to contribute:

- start with [CONTRIBUTING.md](CONTRIBUTING.md)
- run `npm run check` before opening a change
- run `npm run test:live` when changing serializer coverage, region parity, or validation behavior
- keep examples, fixtures, and docs free of customer-specific data

## Additional Documentation

- [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
