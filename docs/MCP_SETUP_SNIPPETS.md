# MCP Setup Snippets

Remote MCP endpoint:

`https://aws-pricing-calculator-mcp.dave-lindon10.workers.dev/mcp`

## Codex CLI

```bash
codex mcp add awsPricingCalculator --url https://aws-pricing-calculator-mcp.dave-lindon10.workers.dev/mcp
```

## Generic `mcp.json` Snippet

For MCP clients that use an `mcpServers` JSON config:

```json
{
  "mcpServers": {
    "awsPricingCalculator": {
      "type": "streamable-http",
      "url": "https://aws-pricing-calculator-mcp.dave-lindon10.workers.dev/mcp"
    }
  }
}
```

## OpenAI API MCP Tool Snippet

```json
{
  "type": "mcp",
  "server_label": "awsPricingCalculator",
  "server_url": "https://aws-pricing-calculator-mcp.dave-lindon10.workers.dev/mcp",
  "require_approval": "never"
}
```
