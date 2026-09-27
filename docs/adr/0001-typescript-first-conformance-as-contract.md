# ADR 0001: TypeScript first, with the conformance suite as the contract

Status: accepted, 2026-09-27

## Context

We built the same Slack RAG agent twice, once in TypeScript on June and once in Go, and
measured both against identical mocked upstreams (`docs/experiments/slack-rag/`). On
June 0.2.0-dev.44, both passed 1,720/1,720 requests at 1–100 concurrent, with the same
latency. The trade-off:

- **TypeScript on June:** 65 lines of app code, where Go took 363. It has durable turns,
  approval gates and Slack streaming built in, and official SDKs for everything
  (Anthropic, MCP, Slack, the Claude Agent SDK).
- **Go:** about 1/6 of the memory under load, 1/3 of the CPU, and a binary about 1/6 the
  size on Linux. No tuning closed that gap: `maxSessions`, a file store and `--smol`
  were all tried.

We may want a Go (or Rust) implementation later, for cost, density or self-hosting.

## Decision

1. **Ship TypeScript on June now.**
2. **The contract between implementations is behavior, not types.** `conformance/` is a
   black-box suite: a mocked Slack and Anthropic plus HTTP-only scenarios. Any
   implementation that passes it is interchangeable. This is how
   `microsoft/typescript-go` ports tsc: against the existing test baselines, not a
   separate spec.
3. **Keep only what's cheap now:**
   - The data we own lives in plain SQL migrations (`migrations/`), in our own
     database, never in the framework's session tables.
   - The prompts and tool descriptions are Markdown files (`prompts/`), embedded at
     build time.
   - The search contract is pinned by `conformance/fixtures/expected-cites.json`.
   - Contract hygiene: IDs are strings, Slack `ts` is a string, and unions are tagged.
4. **Defer until a second implementation actually starts:**
   - OpenAPI/JSON Schema as a single source, with codegen
   - per-rule test vectors
   - a full port layer around June
   - splitting into services

   When that time comes, extract the spec from `conformance/` and this code.

## Consequences

- Framework wiring stays in `src/app.ts`. Tools, policy, prompts and the knowledge
  store don't import June's session internals.
- CI runs the conformance suite against the source and the compiled binary. The
  binary run proves the prompts and migrations are embedded, not read from the repo.
- A behavior change means a conformance scenario change, reviewed like an API change.
