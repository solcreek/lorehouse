# ADR 0005: Tenancy, and what is replaceable

Status: proposed, 2026-10-21

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

**Where an attack on a tenant comes from.** The attacker is usually one of the tenant's
own members, or content someone put in its workspace: a message, a document, a repo.
That input reaches the model (prompt injection), the tools, Lorehouse's parsers and June.
A bug anywhere on that path can give the attacker the process that handles the tenant.
So the question that decides isolation is not whether that process can be taken, but
what else it holds when it is.

What the chat platforms require of whoever receives their events:

| platform | the app must answer within | when it doesn't |
|---|---|---|
| Slack (Events API) | 3 s | the event is redelivered |
| Microsoft Teams (Bot Framework) | 15 s | the activity is resent, so duplicates arrive |
| Google Chat (HTTP app) | 30 s for a synchronous reply | the reply has to go through the Chat API |

Some credentials act for every organization that installed an app, not one: the Slack
app's signing secret and client secret, the Teams bot's app credential, the Google Chat
app's service account, and the GitHub App's private key, which mints a token for any
installation. Others are scoped to one organization: a Slack workspace's bot token, a
GitHub installation token.

[Strongroom](https://github.com/solcreek/strongroom) 0.1.0 binds each token to one tenant,
but one deployment may hold principals of several tenants under one KMS key and one KMS
identity. solcreek/strongroom#12 makes one tenant per deployment, with its own KMS key
and KMS identity, the only form. Destroying that key makes every envelope under it
unrecoverable.

ADR 0003 (layer 5) already requires that a sandbox host serves one tenant until
isolation between tenants is complete.

## Decision

### 1. The tenant is the unit of compromise

**Nothing a tenant sends, and no bug in Lorehouse or June that its input reaches, gives
access to another tenant's content or credentials.** Everything that works on a
tenant's content runs in that tenant's runtime, so an attacker who holds it must escape
a virtual machine to reach another tenant. Every section below follows from this:
- a tenant's content is in files of its own, under a key of its own (section 2);
- a tenant's code runs in a runtime of its own, which holds that tenant's credentials
  and nothing else (section 3);
- the services all tenants share hold no tenant's data key, and no credential that acts
  for every tenant ever enters a tenant's runtime (section 4).

**The shared services are the deliberate exceptions:** the edge, the control plane and
the broker. Every tenant's input reaches them, and no VM stands between one tenant and
another inside them. They are kept few and small, none of them can open a tenant's files,
and section 4 lists what each holds and what its compromise gives. Nothing else is
shared.

### 2. A tenant's data lives in files of its own

**A tenant is one customer organization.** Each tenant's content gets its own set of SQLite
files (knowledge, sessions, Lorehouse's own state). That content is every message,
document, answer, session and usage record.
- **One key per tenant.** The files are encrypted with that tenant's own data key. The
  key is stored only as an envelope under the tenant's own Strongroom deployment and KMS
  key (ADR 0004). Lorehouse requires that deployment to serve this tenant alone, and
  provisions it that way until Strongroom enforces it (solcreek/strongroom#12). It is
  unwrapped in the tenant's runtime, kept in memory only, and never written anywhere in
  the clear.
- **Deleting a tenant** is destroying its KMS key, deleting its files, and purging its
  events not yet delivered (section 4). Destroying the key comes first: it also makes
  every backup and snapshot of the files unreadable. A runtime told that the key is
  destroyed stops serving, drops the key and everything derived from it from memory, and
  never retries or restores. Disabling the key instead suspends the tenant, reversibly.
- **Moving a tenant to another region** is moving its files, after its pending events
  are delivered or purged.

**No tenant's content shares a table with another tenant's.** A query can't reach
another tenant's rows because they aren't in the database it opened. Pooled tables are
for the control plane only (section 4): the tenant registry, routing, installations and
entitlements. They hold no customer content. The one bounded exception is events not yet
delivered (section 4, invariant 4).

**The tenant id is part of every key, log line, metric, job and file path from now on**,
in single-tenant installs too. Moving between deployment forms (section 5) then never
means a migration of identifiers.

### 3. A tenant's runtime is its own

**Each tenant's data plane runs in a virtual machine of its own**, one tenant per VM,
never several tenants in one process or one VM. The VM holds:
- that tenant's files, and no other tenant's;
- that tenant's credentials only: its Strongroom token, its chat workspace's bot token,
  its model key, and short-lived tokens minted for it (section 4).

A host runs many tenants' VMs. Which tenants share a host is placement, not isolation:
a tenant's runtime that is taken reaches nothing of a tenant beside it without escaping
its VM. Those VMs hold unwrapped data keys in memory, so a host that runs several
tenants' runtimes meets every condition of ADR 0003 layer 5, read with "tenant runtime"
for "sandbox", and runs nothing else (layer 4). Until all of them hold, it runs one
tenant's runtime.

**A tenant's VM may stop when idle.** The edge answers the platforms for it (section 4,
invariant 6), so a stopped runtime costs storage and nothing else, and the cost of the
hosted service grows with the tenants that are active, not with all of them. A cold start
includes unwrapping the tenant's data key; how long it takes decides user-visible latency,
not correctness.

### 4. Shared services are few, hold no tenant's key, and act for one tenant at a time

| shared service | holds | tenant input that reaches it | if it is taken |
|---|---|---|---|
| **edge** | the signing secrets of platforms that sign with one (Slack); every tenant's pending events, at most 24 h | every event, as the platform sent it | it sees every new event, and can forge an event from such a platform as any member of any tenant. Events a runtime verifies itself (below) it can only delay, drop or replay within their validity |
| **control plane** | the tenant registry, routing, installations, and where each tenant's runtime and Strongroom deployment are | install and admin flows | it can misroute, stop or start tenants. It holds no data key, Strongroom token or bot token, so it can't open a tenant's files |
| **broker** | the credentials that act for every tenant: the GitHub App's signing right, the chat apps' client secrets and app credentials; a tenant's bot token in passing, during an exchange or a refresh | requests from every tenant's runtime | it can mint tokens for any tenant's installation and post in any tenant's conversations. It holds no data key, so it can't open a tenant's files |

A compromise of any of the three is an incident for every tenant. Checking that an
event's user is a member doesn't authenticate it: a runtime answers a forged question as
it would the member's own.

**The control plane** owns the tenant registry, provisioning and installations: which
chat workspace, Teams tenant or Google Workspace domain belongs to which tenant. It
routes events, and knows where each tenant's runtime and Strongroom deployment are. It
holds no customer content beyond events not yet delivered (invariant 4), no tenant's
data key, and no tenant's Strongroom token.

**Every chat platform's events arrive at the control plane's edge.** The edge parses as
little as it can, because every tenant's input passes through it. It:
- verifies the platform's signature, and forwards the request as the platform signed it;
- answers inside the platform's deadline;
- maps `(platform, platform tenant id)` to a tenant;
- computes the event's idempotency key (below);
- queues the event for that tenant's runtime, which may be stopped or starting up at the
  time.

**Delivery from the edge to a tenant's runtime must hold these invariants.** The mechanism
(the queue, how it's stored, how a stopped runtime is woken) is an implementation
choice, made in its own issue against them:
1. **Durable before acknowledged.** The edge answers the platform only after the event
   is durably accepted, so an edge restart loses nothing.
2. **At least once, until the runtime says so.** A pending event is redelivered until
   the tenant's runtime acknowledges it. The runtime acknowledges only after it has written
   the event and its idempotency key to the tenant's files, in one transaction.
3. **No second answer.** The runtime checks each key against the keys it has recorded,
   in the tenant's files. It keeps them at least as long as pending events are kept, plus
   the platform's retry window.
4. **Pending events are the one exception to "content lives in the tenant's files".**
   They are kept for a bounded time (at most 24 h).
   - Only the edge may write them, and only that tenant's runtime may read them.
   - They're excluded from backups and snapshots, and they stay in the tenant's region
     where the deployment form promises one.
   - They're purged when the tenant is deleted or moved.
   - The 24 h bounds what is kept, not what a held edge can do (the table above).
5. **No shared service can open a tenant's files.** Everything that works on content
   happens only in that tenant's runtime, which opens its files with the tenant's key:
   indexing, search, embeddings, assembling context and the model call. Embeddings and
   indexes are stored in the tenant's files like the rest of its content.
6. **A runtime that is stopped or cold never misses a platform's deadline.** The edge
   answers for it. A runtime that scales to zero is started by something allowed to
   start it. In a tenant's own cloud account, that is something in that account, or a
   start call the tenant grants. Otherwise that form doesn't scale to zero.

**A runtime verifies each event itself where the platform allows it without a shared
secret.** Teams (Bot Framework) and Google Chat sign each request with a token the
runtime checks against the platform's public keys and its own app id, so the edge can't
forge their events. Slack signs with one secret shared by every installation; a runtime
holding it could forge events for any tenant, so for Slack the edge's check stands, and
the edge is trusted for Slack events.

**Each chat surface's contract defines its idempotency key.** The key is scoped to the
tenant and the platform, and stays the same across the platform's retries:
- Where the platform has a native event id, the key uses it.
- Where it doesn't (Google Chat's HTTP events carry none for every event type), the
  contract documents how the key is derived, for example from the message or
  interaction's resource name and type. Its conformance scenarios prove that a resent
  event maps to the same key.

**A credential that acts for every tenant never enters a tenant's runtime.** A broker
holds it, or the KMS key behind it, and uses it on a runtime's behalf, for that runtime's
tenant only. The broker learns which tenant is asking from the runtime's own identity,
never from the request. An install has no runtime yet: its exchange carries a state the
control plane issued for the tenant being provisioned, and the broker binds the result to
that tenant, and to that tenant's runtime only.
- **Code hosts.** The broker signs the GitHub App's JWT (in KMS, ADR 0004) and mints an
  installation token only for the asking tenant's installation, only for the repos and
  permissions its turn needs.
- **Chat platforms whose app credential is global.** Where posting needs the app's own
  credential (Teams, Google Chat), the broker posts, or mints a token scoped to the
  tenant's conversations if the platform has one. Where the platform issues a credential
  per organization (a Slack workspace's bot token), the runtime holds that one directly.
  Getting it still takes the app's client secret: the broker runs the install's code
  exchange and every refresh of a rotating token, hands the token to the tenant's
  runtime, and keeps no copy, nor does the control plane.
- **Shared signing secrets** (Slack's) stay with the edge.

**Hosted, there is one app per chat platform** (one Slack app, one Teams app, one Google
Chat app), installed by each organization through the platform's own consent flow. A
tenant may bring its own app instead: a self-hosted install has one by definition, and
a tenant on its own deployment may choose one. Its credentials then belong to that tenant
and go to its runtime.

**The model provider key is per tenant** where the provider allows one: a key the tenant
brings, or one Lorehouse provisions per tenant (for example in a provider workspace of
its own), so a key taken from one runtime is revoked and limited for that tenant alone.

### 5. Deployment forms, one codebase

All of them run the same binary and pass the same conformance suite (ADR 0001), and in
all of them a tenant's runtime is its own (section 3). They differ in what a tenant
shares with others below the VM:

| form | a tenant's runtime runs on | sandbox hosts | a VM escape reaches |
|---|---|---|---|
| **hosted** | hosts shared by many tenants' VMs, under ADR 0003 layer 5's conditions (section 3) | the tenant's own, until ADR 0003 layer 5 is complete | the tenants on that host |
| **dedicated** | hosts that run only this tenant's VMs | the tenant's own | this tenant only |
| **isolated cloud account** | a dedicated deployment in a cloud project or account of the tenant's own, made by the same provisioning code, in the tenant's region | in that account | this tenant only, and KMS quota and billing are separate too |

Self-hosting is a dedicated deployment with one tenant, and the control plane's edge
folded into the process.

### 6. Replaceable by contract

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
  - The contract says which of the platform's credentials are per organization and which
    are global (section 4).
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
  - The key is per tenant (section 4).
- **Code host.** Covers clone, stage and push, the approval to write, and the identity
  mapping (ADR 0003 layer 1 and the Approve flow).
  - GitHub first, then GitLab and the others.
  - Tokens come from the broker, scoped to the tenant's installation (section 4).
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
  directory of files per tenant, each with its own key under the tenant's own Strongroom
  deployment, and the tenant id threaded through config, logs and jobs.
- **No process that works on a tenant's content serves two tenants.** Only the edge,
  the control plane and the broker serve many, and none of them opens a tenant's files
  (section 4's table).
  Lorehouse never needs to resolve configuration, storage, schedules or sessions for many
  tenants within one process, and June's in-process state (its session store, its Slack
  event dedup) is one tenant's by construction.
- **Each tenant costs a VM, a Strongroom deployment and a KMS key.** Before the hosted
  form is built, a spike measures what that costs per tenant: a runtime's idle memory,
  its cold start including the key unwrap, how many tenants' VMs a host holds, and the
  platforms' limits on Strongroom deployments per account. Scaling to zero (section 3) is
  what keeps idle tenants cheap, so it is part of the hosted form, not an optimization.
- **New services and code:**
  - an edge with per-platform verification and acknowledgement, and a delivery mechanism
    meeting section 4's six invariants, designed in its own issue;
  - a broker for the credentials that act for every tenant, with tenant identity taken
    from the runtime's own identity;
  - a tenant registry, and provisioning from code that creates a tenant's runtime, its
    Strongroom deployment and KMS key, and its model key, and that destroys them.
- **New June channels for Teams and Google Chat**, which verify each forwarded request's
  platform token in the tenant's runtime. The conformance mock grows a surface per
  platform, so one scenario runs against each, a forged event included.
- **Code that says Slack moves behind the chat-surface contract:** `src/policy.ts`,
  `src/threads.ts`, `src/slack-guard.ts`, `src/ingest/slack.ts`, the `slack:` ids. The
  `slack:` ids stay valid as one source's ids.
- **Search and content tools get an audience filter** (the asker and the reply's
  audience, intersected), and saved sessions are filtered the same way before they're
  reused.
- **The audience rule doesn't hold today, even for organization-wide material.** Shared
  channels are refused, and only full members are answered, but two gaps remain:
  - Only the asker is checked. A guest who is a member of a listed channel reads a full
    member's answer there, which may quote channels the guest can't open (#155).
  - Saved sessions keep every turn's tool results, and material from a channel later
    turned private or unlisted is still reused in later turns, until June supports
    redaction or filtering (junebuild/june#360).

  The first connector with access lists can't ship before both are fixed.
- **Skills move from `prompts/skills/` to tenant data**, with the shipped ones as seeds.
  `src/prompts.ts` keeps tool prompts (code), not tenant skills.
- **Docs.** AGENTS.md and the README describe Lorehouse as a Slack agent, and are reworded
  as the contracts land.
