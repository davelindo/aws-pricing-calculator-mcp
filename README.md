# aws-pricing-calculator-mcp

![Version](https://img.shields.io/badge/version-4.0.0-2563eb)
![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20streamable--http-7c3aed)

`aws-pricing-calculator-mcp` is a universal, composition-first interface to AWS Pricing
Calculator. Give it prose, service lists, graph-shaped JSON, CloudFormation, Terraform-shaped
data, or several incomplete sources. It preserves the supplied components and relationships,
resolves what it can, asks targeted questions about what it cannot, prices the resolved graph, and
creates an official calculator link only when the full in-scope architecture is eligible.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_service_catalog` | Inspect service identity, regional pricing, and calculator support |
| `interpret_architecture` | Normalize arbitrary definitions into a provenance-aware component graph |
| `price_architecture` | Price resolved component instances and report partial/full coverage |
| `generate_calculator_link` | Interpret, price, save, fetch, and verify an eligible composition |

The architecture graph is the source of truth. The engine does not select a preset architecture or
add neighboring services to make the input resemble one.

## Core behavior

- Component instances and quantities are preserved; two buckets remain two components.
- Relationships from graphs, CloudFormation references, Terraform references, and text arrows are
  retained.
- Explicit exclusions are first-class constraints.
- Unknown AWS resources remain visible with open IDs and targeted resolution questions.
- Explicit component budgets and configuration facts take precedence over inferred defaults.
- Every compatibility default used for calculator serialization is recorded as an assumption.
- Partial pricing remains available, but unresolved, unsupported, or modeled-only components block
  a full exact link.
- Saved estimates are fetched again and checked against the immutable line-item plan.

Understanding coverage and calculator coverage are deliberately separate. At runtime the service
resolver is extended from AWS's published Calculator manifest, and each selected service definition
is bound and compiled from its published inputs. Missing facts remain targeted questions; they are
never replaced with guessed calculator values.

## Getting started

Prerequisites:

- Node.js `>=18`
- npm
- network access to AWS calculator endpoints when creating links or running live parity tests

Install and check:

```bash
npm install
npm run check
```

Run over stdio:

```bash
npm start
```

Or run the executable directly:

```bash
node bin/aws-pricing-calculator-mcp.js
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "awsPricingCalculator": {
      "command": "node",
      "args": ["bin/aws-pricing-calculator-mcp.js"],
      "cwd": "/absolute/path/to/aws-calculator-mcp"
    }
  }
}
```

## Example workflow

Interpret a mixed partial definition:

```json
{
  "sources": [
    {
      "id": "stack",
      "formatHint": "cloudformation",
      "content": {
        "Resources": {
          "Assets": { "Type": "AWS::S3::Bucket" },
          "Distribution": { "Type": "AWS::CloudFront::Distribution" }
        }
      }
    },
    {
      "id": "requirements",
      "formatHint": "natural-language",
      "content": "Route 53 provides DNS. Do not add Lambda or API Gateway."
    }
  ],
  "context": {
    "region": "us-east-1",
    "targetMonthlyUsd": 1200
  }
}
```

Call `interpret_architecture`. The result includes:

- `components` with resolution state, configuration, usage, scope, and provenance;
- `relationships` between component instances;
- `constraints`, `assumptions`, and `conflicts`;
- `unresolved` items and targeted `questions`;
- an `architectureRef` for the next tool call.

Pass the returned `architectureRef` to `price_architecture`. Inspect:

- `componentPlans` and per-component costs;
- `coverage.unpricedComponentIds`;
- `eligibility.blockers`;
- the immutable `lineItemPlan` and recorded assumptions.

Call `generate_calculator_link` with the same raw input, an architecture reference, a priced result,
or an eligible pricing commit. The tool fails closed unless every included component is represented
by the exact saved estimate.

### Bedrock inference example

This explicit-usage definition resolves and prices the current verified Amazon Nova Lite calculator
shape without inventing a monthly workload:

```json
{
  "definition": {
    "title": "Bedrock Nova Lite inference example",
    "components": [
      {
        "id": "foundation-model",
        "serviceId": "amazon-bedrock",
        "configuration": {
          "provider": "amazon",
          "model": "Amazon Nova Lite",
          "inferenceRoute": "geo-cross-region",
          "inferenceType": "on-demand-standard",
          "imageInput": false,
          "promptCaching": false
        },
        "usage": {
          "averageRequestsPerMinute": 10,
          "hoursPerDay": 8,
          "averageInputTokensPerRequest": 1000,
          "averageOutputTokensPerRequest": 250
        }
      }
    ]
  },
  "context": {
    "region": "us-east-1",
    "targetMonthlyUsd": 17.28
  }
}
```

At the pinned rates, this is 144 million input tokens plus 36 million output tokens per month,
for 17.28 USD/month. Unsupported Bedrock providers, models, routes, images, or prompt caching fail
closed instead of being serialized as the verified Nova Lite shape.

The same path works for services that have no handwritten module. For example, Step Functions
Standard Workflows with `100000` executions per month and `10` state transitions per workflow
compile from AWS's live nested definitions to 24.90 USD/month in `us-east-1`.

## Cloudflare Worker

Run locally:

```bash
npm run worker:dev
```

Deploy:

```bash
npm run worker:deploy
```

The Worker is Cloudflare Access-only and serves:

- `/` service information
- `/health` health information
- `/chat` the Gemini chat workspace
- `/mcp` the streamable HTTP MCP endpoint

Required bindings and variables are documented in [the operator guide](docs/OPERATOR_GUIDE.md).

Remote configuration:

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

## Useful commands

```bash
npm run check
```

Runs syntax checks, verifies generated contract artifacts, and runs the test suite.

```bash
npm run contracts:generate
```

Regenerates the checked-in schemas and emitted MCP tool snapshot under `docs/contracts/v2/`.

```bash
npm run test:live
```

Runs the live save/fetch parity suite when `AWS_CALCULATOR_LIVE=1` is set.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/server.js` | Canonical MCP server entry point |
| `src/universal/architecture.js` | Source adapters and canonical architecture graph |
| `src/universal/service-registry.js` | Layered service identifiers and resolver metadata |
| `src/universal/pricing.js` | Compositional component pricing and immutable line-item plans |
| `src/universal/validation.js` | Generic service, total, target, and region validation |
| `src/universal/runtime.js` | References, pricing commits, link save/fetch, and round-trip checks |
| `src/calculator-catalog/` | Live AWS Calculator manifest discovery, identity, cache, and coverage audit |
| `src/calculator-definition/` | Generic definition compiler plus explicit specialized adapters |
| `src/universal/dynamic/` | Architecture-fact binding, conditions, provenance, and targeted questions |
| `src/services/` | Service serializers and saved-cost models |
| `src/contract/v2.js` | Open MCP contract definitions |
| `docs/contracts/v2/` | Generated schemas and tool snapshot |
| `src/chatbot/` | Gemini orchestration and chat storage |
| `src/worker.js` | Cloudflare Worker host |

## Documentation

- [Universal interface design](docs/UNIVERSAL_INTERFACE_V2.md)
- [Operator guide](docs/OPERATOR_GUIDE.md)
- [Service compatibility matrix](docs/SERVICE_COMPATIBILITY_MATRIX.md)
- [MCP setup snippets](docs/MCP_SETUP_SNIPPETS.md)
- [Contributing](CONTRIBUTING.md)
