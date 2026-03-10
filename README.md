# aws-pricing-calculator-mcp

Internal MCP for coding agents that need to produce funding-ready AWS Pricing Calculator links.

The end artifact is always an official shared estimate:

`https://calculator.aws/#/estimate?id=<saved-estimate-id>`

This repo is opinionated for partner funding workflows.

## What This MCP Does

It gives agents a concrete workflow instead of a single fire-and-forget generator:

1. `plan_estimate`
   Normalize a template choice or rough infra brief into an explicit estimate plan.
2. `create_calculator_link`
   Build a legitimate AWS calculator payload from that plan, save it through AWS's calculator backend, and return the official share link.
3. `validate_calculator_link`
   Fetch the saved estimate and run funding-readiness checks.

That split matters because partner requests are often vague at the start. The planning step makes the assumptions visible before the calculator link is created.

## Why This Matters

- the output is a real AWS calculator link
- the flow is stable enough for agents and automation
- the estimate is checked after AWS saves it, so validation is based on what AWS stored

## Current V1 Scope

- Internal use only.
- Region support: `us-east-1`.
- Database support: PostgreSQL only.
- Templates:
  - `eks-rds-standard`
  - `linux-heavy`
  - `windows-heavy`
- Supportive infra modeled today:
  - `Amazon Virtual Private Cloud (VPC)`
  - `NAT Gateway`

If a brief mentions unsupported database engines or unsupported regions as hard requirements, the planner surfaces that before link creation.

## Install

```bash
npm install
```

Run the MCP server on stdio:

```bash
npm start
```

You can also execute the bin entry directly:

```bash
node ./bin/aws-pricing-calculator-mcp.js
```

## MCP Client Config

Example `mcpServers` entry:

```json
{
  "mcpServers": {
    "aws-pricing-calculator": {
      "command": "node",
      "args": [
        "/absolute/path/to/aws-pricing-calculator-mcp/bin/aws-pricing-calculator-mcp.js"
      ]
    }
  }
}
```

## Tooling Workflow

### `list_templates`

Use this first if the agent needs to discover what this MCP can model.

Returns:

- template ids
- descriptions
- required services
- supportive infra coverage
- supported regions
- default environment split

### `plan_estimate`

Use this to normalize either:

- a known template plus overrides
- a rough funding brief

Inputs:

- `templateId` optional
- `brief` optional
- `targetMonthlyUsd` optional
- `region` optional
- `clientName` optional
- `estimateName` optional
- `notes` optional
- `operatingSystem` optional
- `environmentSplit` optional

Outputs:

- `readyToCreate`
- `blockers`
- `warnings`
- `assumptions`
- normalized target region and budget
- normalized environment split
- service plan summary
- service breakdown
- `createInput`

`createInput` is the safe handoff object for `create_calculator_link`.

### `create_calculator_link`

Use this with either:

- the `plan` returned by `plan_estimate`
- the same high-level inputs directly

Returns:

- official `shareLink`
- `estimateId`
- modeled and stored monthly totals
- service breakdown
- funding validation result
- note that the shared link opens in a read-only viewer

### `validate_calculator_link`

Use this on any saved AWS calculator link to check:

- region consistency
- required service coverage
- modeled vs stored cost consistency
- environment coverage
- supportive spend ratio
- target-budget alignment

If `templateId` is omitted, the validator infers the template from the saved service mix.

## Example Agent Flow

Planning from a rough brief:

```json
{
  "brief": "ExampleCo needs a 7k MRR calculator for us-east-1 with EKS + RDS. They currently run ECS + Postgres and use a 20/30/50 dev/staging/prod split."
}
```

Creating a link from the returned plan:

```json
{
  "plan": {
    "createInput": {
      "templateId": "eks-rds-standard",
      "targetMonthlyUsd": 7000,
      "region": "us-east-1",
      "clientName": "ExampleCo",
      "estimateName": "ExampleCo - EKS + RDS + Supportive Baseline",
      "notes": null,
      "environmentSplit": {
        "dev": 0.2,
        "staging": 0.3,
        "prod": 0.5
      },
      "operatingSystem": "linux"
    }
  }
}
```

Validating an existing shared estimate:

```json
{
  "shareLinkOrEstimateId": "https://calculator.aws/#/estimate?id=<saved-estimate-id>",
  "templateId": "eks-rds-standard",
  "expectedMonthlyUsd": 7000,
  "expectedRegion": "us-east-1"
}
```

## Funding Validation Rules

Validation checks the saved estimate against funding-oriented rules.

Current checks include:

- service entries exist
- each saved service is covered by a modeled pricing formula
- stored service totals still match modeled totals from `calculationComponents`
- top-level total and group subtotal match the modeled sum
- all services stay in one region
- required services for the selected template exist
- dev/staging/prod environment coverage is present
- EC2 OS matches the template
- supportive spend stays under the template cap
- primary spend remains dominant
- monthly total stays within the target tolerance band

Validation output separates:

- hard failures
- soft warnings
- assumptions used during validation

Default target tolerance is `+-10%`.

## Shared Link Behavior

AWS shared estimate links open in a read-only viewer.

What users can do immediately:

- inspect line items
- open config summaries
- review descriptions

For full service editing inside AWS, click `Update estimate` from the shared page. That switches the estimate into AWS's editable flow.

## Tests

Run local checks:

```bash
npm run check
```

Run only tests:

```bash
npm test
```

Run live AWS save/fetch round-trips:

```bash
npm run test:live
```

`test:live` is opt-in and only runs when `AWS_CALCULATOR_LIVE=1` is set by the script. It exercises the real AWS calculator save/fetch path for the supported templates.

## Repo Layout

- `src/server.js`: MCP tool registration and response shaping
- `src/planner.js`: brief inference, normalization, and modeled estimate creation
- `src/model.js`: pricing assumptions and AWS calculator service builders
- `src/validation.js`: funding-readiness validation
- `src/calculator-client.js`: AWS calculator save/fetch client

## Current Coverage

- focused on partner funding calculator workflows
- models the supported templates and service set documented above
- returns official shared estimate links
- supports full service editing after `Update estimate` is clicked in AWS
