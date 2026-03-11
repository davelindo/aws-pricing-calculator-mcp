# Contributing

Thanks for contributing to `aws-pricing-calculator-mcp`.

## Local Setup

```bash
npm install
npm run check
```

The project requires Node.js `>=18`.

## Change Expectations

- Keep the MCP tool surface in sync with [src/server.js](src/server.js).
- Add or update tests for serializer, pricing, validation, or blueprint changes.
- Update [README.md](README.md) and [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) when the user-facing workflow changes.
- Keep examples, fixtures, and documentation free of customer-specific or sensitive data.

## Validation Before Opening A Change

Run this for all changes:

```bash
npm run check
```

Also run this when you change calculator serializers, region coverage, saved-estimate parity, or validation logic:

```bash
npm run test:live
```

## Working On Service Coverage

Service implementations live in `src/services/`.

If you need to inspect AWS calculator definitions while developing serializer support, start with:

```bash
node scripts/extract-calculator-definitions.mjs
```

Then add or update:

- the service module in `src/services/`
- scenario or catalog behavior if the service changes blueprint coverage
- local tests
- live parity coverage where appropriate

## Pull Requests

Open a pull request with:

- a short summary of the change
- the affected blueprint or service families
- the commands you ran
- any known gaps or follow-up work
