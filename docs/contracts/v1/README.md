# v1 Contract Artifacts

These files are the checked-in `v1` MCP contract for `aws-pricing-calculator-mcp`.

Contents:

- `manifest.json`: frozen tool surface and stable enum/id sets
- `list-tools.snapshot.json`: actual `listTools` payload emitted by the MCP server
- `*.input.schema.json`: per-tool input schemas when the tool accepts arguments
- `*.output.schema.json`: per-tool success output schemas
- `tool-error.schema.json`: shared structured tool error envelope used with `isError: true`

Compatibility rules for `v1`:

- Tool names are stable.
- Required top-level fields and enum literals are stable.
- Tool-originated failures return MCP tool results with `isError: true`.
- Additive optional fields are allowed.
- Renaming or removing stable ids, fields, or enum literals is breaking.

These artifacts are generated from `src/contract/v1.js` via:

```bash
npm run contracts:generate
```
