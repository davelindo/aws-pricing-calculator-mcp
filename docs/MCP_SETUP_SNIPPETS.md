# MCP Setup Snippets

Remote MCP endpoint:

`https://<worker-name>.<account-subdomain>.workers.dev/mcp`

These snippets assume the Worker is protected by Cloudflare Access. Remote clients must be able to authenticate through Access or connect through an approved proxy that supplies a valid `Cf-Access-Jwt-Assertion`.

## Claude

### Claude / Claude Desktop

For Claude and Claude Desktop, add this MCP as a custom remote connector:

1. Open `Settings -> Connectors`
2. Click `Add custom connector`
3. Name it `AWS Pricing Calculator`
4. Set the URL to `https://<worker-name>.<account-subdomain>.workers.dev/mcp`
5. Configure authentication for the Access-protected deployment or front the Worker with your own auth layer
6. Click `Add`

Notes:
- Custom remote MCP connectors are currently available in beta on Claude and Claude Desktop
- Claude Desktop remote MCP servers should be added through `Settings -> Connectors`, not `claude_desktop_config.json`
- On Team and Enterprise plans, an owner may need to add the connector first before members can use it

### Claude Code

```bash
claude mcp add --transport http awsPricingCalculator https://<worker-name>.<account-subdomain>.workers.dev/mcp
```

Optional verification:

```bash
claude mcp list
claude mcp get awsPricingCalculator
```

## Codex CLI

```bash
codex mcp add awsPricingCalculator --url https://<worker-name>.<account-subdomain>.workers.dev/mcp
```

## Generic `mcp.json` Snippet

For MCP clients that use an `mcpServers` JSON config:

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

## OpenAI API MCP Tool Snippet

```json
{
  "type": "mcp",
  "server_label": "awsPricingCalculator",
  "server_url": "https://<worker-name>.<account-subdomain>.workers.dev/mcp",
  "require_approval": "never"
}
```
