# v2 MCP Contract

The v2 contract is the universal, composition-first interface. It accepts open source formats and
open service identifiers, returns a provenance-aware architecture graph, and reports pricing and
calculator eligibility per component.

The checked-in files in this directory are generated from `src/contract/v2.js`:

- `manifest.json` lists the v2 tools and schema IDs.
- `list-tools.snapshot.json` records the MCP metadata emitted by `src/server-v2.js`.
- `*.input.schema.json` and `*.output.schema.json` are the tool schemas.
- `tool-error.schema.json` is the shared v2 error envelope.

Regenerate both contract versions with:

```bash
npm run contracts:generate
```

Service identifiers remain open strings rather than catalog-derived enums. Unknown components stay
in the architecture graph and block a full exact link until they are resolved, excluded, or
supported.
