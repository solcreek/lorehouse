# ADR 0005: Tenancy, and what is replaceable

Status: proposed, 2026-10-16

## Context

Lorehouse is meant to serve organizations of any industry, size and domain, as a hosted
service first and self-hosted too, from one codebase. What exists today assumes one
organization per install, Slack as the only chat platform and the only knowledge
source, one model provider, and GitHub as the only code host:
- **One install, one organization.** `LOREHOUSE_DB` and `SESSIONS_DB` are each one SQLite
  file. Configuration is per process.
- **Slack everywhere.** Document ids are `slack:<channel>:<ts>`, and policy is in Slack's
  terms (public channels, `team_id`). June, the agent framework, has channels for Slack,
  Crisp and plain HTTP only.
- **Skills and profiles are compiled in.** They live in `prompts/` and the binary.

What the chat platforms require of whoever receives their events:

| platform | the app must answer within | when it doesn't |
|---|---|---|
| Slack (Events API) | 3 s | the event is redelivered |
| Microsoft Teams (Bot Framework) | 15 s | the activity is resent, so duplicates arrive |
| Google Chat (HTTP app) | 30 s for a synchronous reply | the reply has to go through the Chat API |

ADR 0003 (layer 5) already requires that a sandbox host serves one tenant until
isolation between tenants is complete.

## Decision

### 1. A tenant's data lives in files of its own

**A tenant is one customer organization.** Each tenant's content gets its own set of SQLite
files (knowledge, sessions, Lorehouse's own state). That content is every message,
document, answer, session and usage record.
- **One key per tenant.** The files are encrypted with that tenant's own data key, held
  as an envelope under KMS (ADR 0004).
- **Deleting a tenant** is deleting its files and destroying its key.
- **Moving a tenant to another region** is moving its files.

**No tenant's content shares a table with another tenant's.** A query can't reach
another tenant's rows because they aren't in the database it opened. Pooled tables are
for the control plane only (section 2): the tenant registry, routing, installations and
entitlements. They hold no customer content.

**The tenant id is part of every key, log line, metric, job and file path from now on**,
in single-tenant installs too. Moving between deployment forms (section 3) then never
means a migration of identifiers.

### 2. A control plane in front, data planes behind

- **The control plane** owns the tenant registry, provisioning and installations: which
  chat workspace, Teams tenant or Google Workspace domain belongs to which tenant. It
  also routes events. It is multi-tenant by nature and holds no customer content.
- **A data plane** runs Lorehouse for one or more tenants (section 3), against their files.

**Every chat platform's events arrive at the control plane's edge.** The edge:
- verifies the platform's signature;
- answers inside the platform's deadline;
- maps `(platform, platform tenant id)` to a tenant;
- computes the event's idempotency key (below);
- hands the event to that tenant's data plane, which may be starting up at the time.

**The edge acknowledges an event only after it is durable.** Before answering the
platform, the edge appends the event to that tenant's **inbox**: a queue held by the
control plane, of events the edge can't read back.
- **Sealed to a key the edge doesn't hold.** Each tenant has an inbox key pair. The edge
  holds only the public half, and each event is sealed to it (public-key encryption). The
  private half stays with the tenant's data plane, under that tenant's KMS key (ADR 0004).
  The edge can write a tenant's inbox but never decrypt it. It never touches the data key
  that encrypts the tenant's files.
- **Taken by the data plane, which connects out.** Like a sandbox runner, the data plane
  takes its events over an outbound connection. A stopped data plane loses nothing: its
  events wait until it starts. A deployment in a tenant's own cloud account needs no way
  in from the control plane.
- **Kept briefly.** An event stays until its data plane has taken and acknowledged it, and
  at most a bounded time (24 h), after which it is dropped and counted.

So the control plane holds tenants' content only as ciphertext it can't open. Its registry
holds none at all. An edge that restarts after acknowledging loses nothing. A data plane
that is stopped or cold therefore never misses a platform's deadline, so an idle
tenant's compute can scale to zero.

Delivery from the inbox to the data plane is **at least once, with an idempotency key**.
Redelivery, which every platform above does, never produces a second answer.

**Each chat surface's contract defines its idempotency key.** The key is scoped to the
tenant and the platform, and stays the same across the platform's retries:
- Where the platform has a native event id, the key uses it.
- Where it doesn't (Google Chat's HTTP events carry none for every event type), the
  contract documents how the key is derived, for example from the message or
  interaction's resource name and type. Its conformance scenarios prove that a resent
  event maps to the same key.

**Hosted, there is one app per chat platform** (one Slack app, one Teams app, one Google
Chat app), installed by each organization through the platform's own consent flow. A
tenant may bring its own app instead: a self-hosted install has one by definition, and
a tenant on its own deployment may choose one.

### 3. Deployment forms, one codebase

All three run the same binary and pass the same conformance suite (ADR 0001):

| form | compute | data | sandbox hosts |
|---|---|---|---|
| **single-tenant** | one data plane per tenant | that tenant's files | that tenant's own (ADR 0003 layer 5 holds trivially) |
| **cell** | one data plane serves many tenants, each with its own files | per-tenant files | per tenant, until layer 5 is complete |
| **isolated cloud account** | a single-tenant deployment in a cloud project or account of the tenant's own, made by the same provisioning code | in the tenant's region | in that account |

**Single-tenant comes first**: it needs almost no change to the data plane. A cell needs
the data plane to resolve configuration, storage, schedules and sessions per tenant
within one process. That is planned now (the tenant id in every key, section 1) and
built after. Self-hosting is the single-tenant form with the control plane's edge
folded into the process.

### 4. Replaceable by contract

Each of these is an interface with conformance scenarios of its own. Slack, GitHub and
Anthropic are the first implementations, never assumptions in the core:

- **Chat surface.** Covers receiving events, posting and updating replies, files,
  identities (who asked, by name), and the platform's notion of a public, shared
  conversation.
  - The first targets are Slack, Microsoft Teams and Google Chat. Others follow the same
    contract, such as LINE WORKS, Lark or Discord.
  - A surface is a June channel. Where June has none, it's written there, not in
    Lorehouse.
  - Policy is written in the surface's terms through the contract ("a conversation every
    member of the organization can read"), not in Slack's.
- **Knowledge source.** A connector syncs documents into the tenant's knowledge files.
  - It also keeps them true to the source: edits, deletions and changes to who may see
    them.
  - Document ids are `<source>:<source-scoped id>`.
  - **Visibility is per document.** A source either says a document is visible to the
    whole organization (today's rule), or carries its access list.
  - **What may reach the model is what everyone who will read the answer may see.** That
    is the intersection of the asker's access and the reply's audience, not the asker's
    access alone. Otherwise a person allowed to read a restricted document could have it
    summarized into a thread the whole organization reads.
    - The chat surface's contract says who the audience of a conversation is, and the
      knowledge source's says who may see a document.
    - Search and every tool that returns content filter by that intersection *before*
      anything is passed to the model.
    - A conversation the whole organization can read uses only material visible to the
      whole organization.
    - Restricted material is used only where the audience is known and every member of
      it is authorized, as in a direct message with its asker.
    - When the audience can't be determined, restricted material is excluded.
  - **Session context follows the same rule.** A session's saved turns, tool results
    included, may hold material retrieved for an earlier audience. Before they're reused,
    for a later turn, another participant, or a changed audience, they're filtered by the
    current audience, or the session starts without them. A thread's audience can grow;
    what was fine to say to fewer people isn't automatically fine to repeat to more.
  - Chat history is one source. Docs, wikis, tickets, email and code are others.
- **Model provider.** Covers the provider and model per tenant and per profile.
  - Anthropic's API, cloud providers' hosted endpoints (Bedrock, Vertex, Azure), and
    endpoints a tenant runs itself.
  - The key is the tenant's own when it brings one (ADR 0004).
- **Code host.** Covers clone, stage and push, the approval to write, and the identity
  mapping (ADR 0003 layer 1 and the Approve flow).
  - GitHub first, then GitLab and the others.
  - **Code work is an optional capability of a profile** (ADR 0002). The core, answering
    from an organization's knowledge, needs no code host and no sandbox.
- **Sandbox provider.** Covers runners Lorehouse hosts, runners a tenant hosts (they
  already connect out, `docs/sandbox-runners.md`), or another provider behind the same
  sandbox interface, all under ADR 0003.
- **Skills and profiles per tenant, at runtime.**
  - A tenant's skills and profile settings are data in its files, edited by its admins.
  - Shipped skills are defaults.
  - ADR 0002's rules no profile can change, and ADR 0003's layers 1–3, are code, never
    data.

## Consequences

- **What everything else builds on.** Tenancy lands in the storage layer first: one
  directory of files per tenant, each with its own key, and the tenant id threaded
  through config, logs and jobs. Every other item builds on it.
- **New services and code:**
  - an edge with per-platform verification and acknowledgement, and an idempotent hand-off;
  - a tenant registry, and provisioning that creates a single-tenant deployment from
    code.
- **New June channels for Teams and Google Chat.** The conformance mock grows a surface
  per platform, so one scenario runs against each.
- **Code that says Slack moves behind the chat-surface contract:** `src/policy.ts`,
  `src/threads.ts`, `src/slack-guard.ts`, `src/ingest/slack.ts`, the `slack:` ids. The
  `slack:` ids stay valid as one source's ids.
- **Search and content tools get an audience filter** (the asker and the reply's
  audience, intersected), and saved sessions are filtered the same way before they're
  reused.
- **Neither half holds today**, even for organization-wide material.
  - The public-channels rule doesn't check every reader:
    - a channel shared with another organization (Slack Connect) can be listed;
    - a guest who can't open every listed channel can ask (#145).
  - Saved sessions keep every turn's tool results. Material from a channel later turned
    private or unlisted is still reused in later turns, until June supports redaction or
    filtering (junebuild/june#360).
  - The first connector with access lists can't ship before both are fixed.
- **Skills move from `prompts/skills/` to tenant data**, with the shipped ones as seeds.
  `src/prompts.ts` keeps tool prompts (code), not tenant skills.
- **Open questions before a cell is built**, each a spike:
  - Can June hold many tenants' session stores in one process?
  - How fast does a cold single-tenant data plane take over from the edge? The edge
    removes the platform deadline, so this is about user-visible latency, not
    correctness.
- **Docs.** AGENTS.md and the README describe Lorehouse as a Slack agent, and are reworded
  as the contracts land.
