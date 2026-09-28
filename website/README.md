# Lorehouse website

The landing page, built on [June](https://june.build), the framework Lorehouse itself
runs on. What the page says, and why it looks like an engineering drawing, is decided in
[docs/positioning.md](../docs/positioning.md). How this came to be on June, and what
broke on the way, is in
[docs/experiments/website-on-june/FINDINGS.md](../docs/experiments/website-on-june/FINDINGS.md).

## Run it

```bash
cd website
bun install
bun run dev        # http://localhost:3000, with a local SQLite file in .june/
bun run build      # dist/: the Workers bundle, with / prerendered
bun run typecheck
```

To run the built worker the way Cloudflare will (workerd, local D1):

```bash
cd dist
bunx wrangler d1 execute lorehouse-website-db --local --persist-to ../.june/wrangler \
  --file ../db/migrations/0001_early_access.sql
bunx wrangler dev --local --persist-to ../.june/wrangler
```

## Layout

| path | what |
|---|---|
| `app/page.tsx` | the landing page, plus its `.md` and `.json` versions for agents |
| `app/SystemDrawing.tsx` | the system drawing; its linework is each part's build status |
| `app/EarlyAccess.tsx` | the early-access form, the page's only client JavaScript |
| `app/_actions.ts` | `join_early_access`: the form's action and an MCP tool at `/mcp` |
| `app/global.css` | every style on the page |
| `db/migrations/` | the early-access table |

June versions are pinned to the same dev line as the app (`../package.json`). The npm
`latest` line can't take a POST on Workers; see the findings.
