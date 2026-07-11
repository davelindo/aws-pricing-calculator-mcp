# Universal Architecture Interface

## Contract

The caller's architecture is the source of truth. The system builds a partial, provenance-aware
component graph and never adds resources merely to make the definition resemble a preset.

Universal ingestion and calculator coverage are separate:

- **Ingestion coverage** says which source facts and components were retained.
- **Resolution coverage** says which components map to a registered AWS service.
- **Pricing coverage** says which resolved components can be modeled.
- **Calculator coverage** says which priced components can be serialized, saved, fetched, and
  verified.

An architecture can be understood even when it is not eligible for an exact calculator link.

## Pipeline

```text
source definitions
  -> format-aware evidence extraction
  -> component and relationship graph
  -> live Calculator manifest resolution with alternatives and confidence
  -> completeness and coverage analysis
  -> published input binding with provenance and targeted questions
  -> generic definition compilation or an explicit specialized adapter
  -> compositional component pricing
  -> immutable calculator line-item plan
  -> save, fetch, and generic round-trip validation
```

## Canonical graph

The architecture IR preserves:

- component instance identity and multiplicity;
- original labels, resource types, source locations, and excerpts;
- resolved service IDs, alternatives, rationale, and confidence;
- relationships between component instances;
- region, environment, configuration, usage, and quantity facts;
- explicit exclusions and uncertain inclusion;
- constraints, assumptions, contradictions, and targeted questions;
- per-component pricing and calculator support.

Unknown resources are represented with open IDs. They are never silently dropped or substituted.

The live catalog uses collision-safe canonical IDs of the form `aws-calculator:<serviceCode>`.
Top-level selectors retain their child-template relationships, so a missing subservice choice is a
question rather than a failed identity match. Manifest and definition content are digest-pinned for
independent repricing after save/fetch.

## Inputs

Callers may pass one `definition` directly or several `sources`. Content may be text or structured
data. `formatHint` and `mediaType` are open strings so new adapters do not require a contract change.

```json
{
  "sources": [
    {
      "id": "stack",
      "mediaType": "application/json",
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
      "mediaType": "text/plain",
      "formatHint": "natural-language",
      "content": "Route 53 provides DNS. Exclude Lambda and API Gateway."
    }
  ],
  "context": {
    "region": "us-east-1",
    "targetMonthlyUsd": 1200
  }
}
```

Explicit facts win over inferences. Conflicting explicit facts remain visible in `conflicts`.

## Resolution states

- `resolved`: one registered service is supported by the evidence;
- `ambiguous`: multiple candidates remain plausible;
- `unresolved`: the component is retained but no registered service is identified;
- `excluded`: the source explicitly removes the component;
- `unsupported`: the service is known but lacks required pricing or serializer support.

Confidence is field- and component-level. Low confidence creates alternatives and questions instead
of forcing a selection.

## Pricing

Pricing consumes component instances directly. Explicit usage, configuration, and component budgets
take precedence. If a current service adapter still requires budget-driven compatibility sizing,
the inferred calculator fields are attached to the component plan as assumptions.

A target budget is a constraint, not permission to invent unrelated resources.

Exact-link eligibility requires complete representation of every included component. Partial known
pricing remains available when unknown or unsupported components exist, but the exact link remains
blocked.

## References and commits

`architectureRef` tokens carry the normalized graph. Eligible scenarios expose pricing commits that
carry the immutable resolved line-item plan. Estimate generation compiles only from that plan, then
fetches the saved estimate and verifies name, total, service count, and service signatures.
