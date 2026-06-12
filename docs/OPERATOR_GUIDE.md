# Operator Guide

## When To Use Which Tool

- Use `design_architecture` when the input is still fuzzy.
- Use `price_architecture` when you want scenario comparison.
- Use `generate_calculator_link` as the default happy path when the goal is “create the official calculator link now.”
- Use `create_calculator_link` only after a scenario is already exact and calculator-eligible, usually via `pricingCommit`.
- Use `validate_calculator_link` to re-check a saved link later or validate an externally created estimate.

## Practical Patterns

One-shot calculator link:

```json
{
  "blueprintId": "edge-api-platform",
  "region": "eu-west-1",
  "targetMonthlyUsd": 9000
}
```

Call `generate_calculator_link`.

Advanced commit flow:

1. Call `price_architecture`.
2. Take `scenarios[*].pricingCommit`.
3. Call `create_calculator_link` with that `pricingCommit`.

Modernization brief:

```json
{
  "brief": "Need a modernization path for a Linux application moving from EC2 toward Fargate with private endpoints and shared storage. Budget is 12k monthly in ca-central-1."
}
```

Enterprise data brief:

```json
{
  "brief": "Need an enterprise data platform in us-east-1 with Aurora PostgreSQL, Redis, OpenSearch, and private connectivity around a 15k monthly budget."
}
```

## Reading The Result

In `design_architecture`, pay attention to:

- `confidence`
- `unresolvedQuestions`
- `serviceCoverage`
- `suggestedNextActions`

In `price_architecture`, pay attention to:

- `deltaDrivers`
- `calculatorEligible`
- `calculatorBlockers`
- `pricingCommit`
- `validation.blockingFailures`

In `generate_calculator_link`, `create_calculator_link`, and `validate_calculator_link`, pay attention to:

- `validation.blockingFailures`
- `validation.warningRules`
- `validation.parityDetails`

## Default Operator Rules

- If the user needs a real calculator link now, keep the scenario exact-capable.
- Prefer `generate_calculator_link` unless you specifically need to compare scenarios or commit a chosen scenario later.
- Non-default regions should carry explicit justification in the notes or surrounding delivery artifacts.
- Premium managed services should also carry explicit justification.
- For hosted Worker deployments, configure Cloudflare Access and validate `Cf-Access-Jwt-Assertion` for every route.
- Configure a `CHAT_STATE` KV namespace before enabling the `/chat` workspace.
- Configure the `CHAT_COORDINATOR` Durable Object binding before enabling the `/chat` API.
- Shared chats are read-only for non-owners; collaborators must fork a shared chat to continue it.

## Worker Routes

- `GET /`: authenticated service metadata
- `GET /health`: authenticated health payload including Gemini and KV readiness
- `GET /chat`: static Gemini chat workspace
- `GET /api/me`: current Access identity
- `GET /api/chats`: owned and shared chat summaries
- `GET /api/chats/:chatId`: visible transcript plus ACL data for owners
- `POST /api/chats`: create a chat, optionally with an initial user message
- `POST /api/chats/:chatId/messages`: continue an owner-controlled thread
- `POST /api/chats/:chatId/shares`: add one shared user by email
- `DELETE /api/chats/:chatId/shares/:email`: revoke one shared user
- `POST /api/chats/:chatId/fork`: clone any readable chat into a new owner-controlled thread

## Exact Coverage

The current shipped catalog is exact across all roadmap regions.

Current exact coverage includes:

- core platform services: EKS, EC2, RDS PostgreSQL, VPC/NAT
- expanded database services: RDS MySQL, RDS SQL Server, Aurora PostgreSQL, Aurora MySQL, ElastiCache, OpenSearch
- storage services: S3, EFS, EBS, FSx Windows
- shared edge and operations services: ALB, NLB, S3, CloudWatch, Route 53, CloudFront
- integration and serverless services: API Gateway, Lambda, DynamoDB, SQS, SNS, EventBridge, Fargate
- private connectivity: VPC Endpoints / PrivateLink
- security services: AWS WAF

Treat `list_service_catalog` as the source of truth for per-region support. A future release may surface `modeled` or `unavailable` states for some services without changing the tool shape.
