# aws-pricing-calculator-mcp

![Version](https://img.shields.io/badge/version-4.0.0-2563eb)
![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-7c3aed)

`aws-pricing-calculator-mcp` is an MCP server for designing AWS architectures, pricing scenarios, creating official AWS Pricing Calculator share links, and validating the saved estimate for funding-oriented review.

## What This Project Does

This project helps an MCP client turn an architecture brief or blueprint into:

- a normalized architecture design
- priced baseline, optimized, and aggressive scenarios
- an official `https://calculator.aws/#/estimate?id=...` share link
- validation results against what AWS actually saved

The server runs over stdio and exposes these tools:

| Tool | Purpose |
| --- | --- |
| `list_blueprints` | Discover the supported blueprint catalog |
| `list_service_catalog` | Inspect service coverage and region support |
| `design_architecture` | Turn a brief or blueprint into a normalized architecture |
| `price_architecture` | Price one or more scenario policies |
| `create_calculator_link` | Save an exact scenario and return the official calculator link |
| `validate_calculator_link` | Fetch a saved estimate and validate it |

## Why It Is Useful

- It produces official AWS calculator links instead of local-only estimates.
- It supports blueprint-driven and brief-driven workflows, so agents can start from either a known pattern or rough input.
- It compares scenario policies explicitly, including commitment posture, HA posture, storage strategy, and shared-service overhead.
- It validates the saved estimate for pricing parity, architecture completeness, funding readiness, and governance signals.
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
git clone git@github.com:davelindo/aws-pricing-calculator-mcp.git
cd aws-pricing-calculator-mcp
npm install
npm run check
```

### Run The MCP Server

```bash
npm start
```

Or run the executable directly:

```bash
node bin/aws-pricing-calculator-mcp.js
```

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

### Typical Workflow

1. List available blueprints.

```json
{}
```

Call `list_blueprints`.

2. Design from a brief.

```json
{
  "brief": "Need a 9k monthly edge API platform in eu-west-1 with CloudFront, Lambda, DynamoDB, Route53, and API Gateway."
}
```

Call `design_architecture`.

3. Price scenarios.

```json
{
  "blueprintId": "edge-api-platform",
  "region": "eu-west-1",
  "targetMonthlyUsd": 9000
}
```

Call `price_architecture`.

4. Create the calculator link from the returned exact scenario.

Pass one of the `scenarios[*]` objects from `price_architecture` into `create_calculator_link` as `pricedScenario`.

5. Validate the saved estimate later by share link or estimate id.

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

Runs the local lint and test suite.

```bash
npm run test:live
```

Runs the live save/fetch parity matrix against AWS calculator endpoints.

## Project Layout

| Path | Purpose |
| --- | --- |
| `src/server.js` | MCP tool registration and schemas |
| `src/architecture.js` | architecture design, scenario pricing, exact link planning |
| `src/planner.js` | estimate construction helpers used by the MCP surface |
| `src/validation.js` | saved-estimate validation and policy checks |
| `src/services/` | service registry, serializers, and saved-cost modeling |
| `docs/OPERATOR_GUIDE.md` | operator-oriented usage notes |
| `test/live-roundtrip.test.js` | live parity matrix for exact coverage |

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
