# Operator Guide

## When To Use Which Tool

- Use `design_architecture` when the input is still fuzzy.
- Use `price_architecture` when you want scenario comparison.
- Use `create_calculator_link` only after a scenario is already exact and calculator-eligible.
- Use `validate_calculator_link` on any saved link that is going to funding review.

## Practical Patterns

Container baseline:

```json
{
  "blueprintId": "container-platform",
  "region": "us-east-1",
  "targetMonthlyUsd": 7000
}
```

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
- `validation.blockingFailures`

In `validate_calculator_link`, pay attention to:

- `validation.blockingFailures`
- `validation.warningRules`
- `validation.parityDetails`

## Default Operator Rules

- If the user needs a real calculator link now, keep the scenario exact-capable.
- Non-default regions should carry explicit justification in the notes or surrounding delivery artifacts.
- Premium managed services should also carry explicit justification.

## Exact Coverage

The shipped catalog is exact across all roadmap regions.

Current exact coverage includes:

- core platform services: EKS, EC2, RDS PostgreSQL, VPC/NAT
- expanded database services: RDS MySQL, RDS SQL Server, Aurora PostgreSQL, Aurora MySQL, ElastiCache, OpenSearch
- storage services: S3, EFS, EBS, FSx Windows
- shared edge and operations services: ALB, NLB, S3, CloudWatch, Route 53, CloudFront
- integration and serverless services: API Gateway, Lambda, DynamoDB, SQS, SNS, EventBridge, Fargate
- private connectivity: VPC Endpoints / PrivateLink
- security services: AWS WAF

That coverage is exercised by the live round-trip suite across all six roadmap regions, plus explicit enterprise and modernization add-on cases.
