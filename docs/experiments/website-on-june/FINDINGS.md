# Spike: the Lorehouse website on June (2026-09-27)

Question: can the marketing site dogfood June instead of Astro? It needs one static
landing page now, an early-access form, and docs later.

**Answer: yes, on the same June line as the app.** Everything the landing page needs
works on `@junejs/core@0.2.0-dev.49` / `@junejs/server@1.0.0-dev.28` /
`@junejs/cli@0.0.52-dev.2`, Bun 1.3.14, macOS. Two of the problems below only exist
on the npm `latest` line (`core 0.1.0`, `server 0.1.1`), which is why `website/` pins the
dev line the app already uses.

## What was verified

Each checked by hand on 2026-09-27, against `june dev` and against the built worker
under `wrangler dev --local` (workerd, local D1).

| | result |
|---|---|
| `june build` prerenders `/` to static HTML, `.md` and `.json` | ✅ |
| `/index.md` serves the page's `md` export; `/index.json` its `json` export | ✅ |
| `/llms.txt`, `/sitemap.xml`, the `Link` discovery header | ✅ |
| `join_early_access` as an MCP tool: valid, duplicate, invalid and missing input | ✅ |
| the same action from the page's form (a `client:load` island), in Chrome | ✅ hydrates, submits, shows the confirmation |
| rows land in SQLite (dev) and in local D1 (worker) | ✅ |
| `june deploy --dry-run` | ✅ wrangler accepts the bundle and the D1 binding |
| layout at 400px wide | looked right in a screenshot; horizontal overflow was not measured |

Not done: a real deploy (needs a Cloudflare account, `wrangler d1 create`, and a decision
on Workers vs Creek), Safari, and a Lighthouse run.

## Findings

### 1. On Workers, every POST reaches the app with its body already read (`server 0.1.1`)

`withAssets` passes the incoming request to `env.ASSETS.fetch()` for every method. For a
POST that consumes the body, the asset lookup 404s, and the pipeline then parses an
empty body: `/mcp` answers every call with `-32700 Parse error`. This breaks any POST
on Workers: MCP, agent turns, channel webhooks. `june dev` is unaffected.

Fixed on the dev line (`server 1.0.0-dev.28` guards the lookup to GET/HEAD). Patching
the built `worker.js` the same way on 0.1.1 made all MCP calls pass. **Worth a backport
to `latest`**, since that is what `npm create june` installs.

### 2. The `create-june` starter can't hydrate its own island (`create-june 0.0.28`)

Checked on a fresh scaffold: its `Counter` is served as a plain `<button>`, with no
`<june-island>` marker.
- The template asks for `@junejs/*@^0.0.25`, which on `0.0.x` installs exactly 0.0.25.
  That core has no JSX runtime, but the template's `client:load` islands need one.
- Its `tsconfig.json` sets `jsxImportSource: "react"`. `client:*` islands only get their
  marker through June's runtime (`"@junejs/core"`). On 0.1.0 and later, changing this
  one line is enough; on 0.0.25 it stops the dev server.
- Its `global.css` imports Tailwind, but it doesn't install `@tailwindcss/postcss`, so
  `june dev` serves the CSS raw.

### 3. The starter stylesheet leaks into apps that have their own (`core 0.2.0-dev.49`)

With `cssReset` on (the default unless `global.css` imports Tailwind), June injects
`STARTER_CONTENT_CSS` as well as the reset: `code { background: #ecebe4 }`,
`main { width: min(720px, …); margin: 72px auto }`, and a body font. The docs say the
starter look applies only when it is the page's whole look; that holds for
`theme-color`, not for this CSS. On a dark page `<code>` became an unreadable light
block. Workaround: `cssReset: false`, with the few reset rules the page needs in
`global.css`.

### 4. A page with no loader can't serve `.json` (`core 0.1.0`)

`GET /index.json` threw `TypeError: Value is not JSON serializable` (500) because the
projection serializes `undefined`. The page now exports an explicit `json`, so this was
not rechecked on the dev line.

### 5. Smaller things

- **Docs vs. code.** The islands page documents `<Island name>` + `hydrateIslands()`; the
  starter and runtime use `client:load` + `startJuneClient()` + a generated
  `_islands.gen.ts`. The OG docs mention `site.url` and `themeColor`, which aren't in the
  0.1.0 config type.
- **Actions register on import.** An action in `app/_actions.ts` is only an MCP tool once
  a route imports it. Not documented.
- **No browser endpoint for actions on 0.1.** The form calls its action through `/mcp`
  (`tools/call`). That works, and it is the same definition, but it means UI errors come
  back as MCP text. Not rechecked on the dev line.
- **`llms.txt` advertises June by default.** Its preamble lists June's package names.
  `agent.llms.framework` replaces it; the site uses it to describe Lorehouse instead.
- **Client JS is heavy for one form.** `client.js` is 503 KB raw, about 96 KB gzipped,
  for a single island (React DOM plus June's client runtime). The HTML itself is 25 KB.
  Acceptable for now; worth revisiting before launch.

## Decisions this spike leaves open

1. ~~Deploy to Workers directly, or through Creek.~~ Through Creek (decided 2026-09-27).
   Creek can't deploy a June build yet; the gaps are tracked in
   [solcreek/creek#54](https://github.com/solcreek/creek/issues/54).
2. Create the production D1 database, and decide who can read the early-access list.
3. Whether the form island is worth ~96 KB, or the form becomes plain HTML posting to a
   route handler.
## Reported upstream (2026-09-27)

| finding | issue |
|---|---|
| 1. Workers POST body consumed; backport the fix to `latest` | [junebuild/june#222](https://github.com/junebuild/june/issues/222) |
| 2. The starter's island never hydrates | [junebuild/june#223](https://github.com/junebuild/june/issues/223) |
| 3. Starter look overrides an app's own CSS | [junebuild/june#224](https://github.com/junebuild/june/issues/224) |
| 4. `.json` throws for a page with no loader | [junebuild/june#225](https://github.com/junebuild/june/issues/225) |
