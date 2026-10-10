# ADR 0002: Profiles — one platform, several agents

Status: proposed, 2026-10-10

## Context

Lorehouse runs one agent. `src/app.ts` builds a single `defineAgent` under the fixed id
`lorehouse`, and the tools it gets depend on environment variables. The positioning
(`docs/positioning.md`) already asks for more than one kind of work:

- **Builds**: open an issue or a pull request when a discussion reaches a decision.
  Something outside Slack starts that work.
- **Keeps learning**: run routines on a schedule, and leave lore behind after a session.
- **Connects**: gain capabilities through connections whose credentials the model never
  holds.

Shopify's River ("Under the River", Shopify Engineering, 2026-05-28) is the closest
public reference. River is one *profile* on a platform called Aquifer: "River is one
profile. Aquifer is the platform." A profile is a system prompt, skills, extensions, a
sandbox policy and model defaults. The same substrate runs three modes: interactive
(River, a person drives it), automation (PR review, an event starts it) and job (batch
or CI, short-lived). Only one of them talks to people in Slack. The others are started
by something else and post their results.

June (`@junejs/core` 0.2.0-dev.49) already has most of the parts:

- `defineAgent({ name, instructions, tools, skills, channels, surfaces })` is close to a
  profile.
- `Skill` (`name`, `description`, `whenToUse`, `body`) and `read_skill`, which loads a
  skill only when the model asks for it.
- `createNativeRuntime({ [id]: def, … })` holds several agents. `runtime.session(agent,
  id)` keeps their sessions apart.
- `ProactiveTrigger` marks a turn that no inbound message started. On the native
  runtime Lorehouse uses, `runDetached` or `runStream` runs it, and the Slack channel's
  `post` or `deliver` puts the result in a thread. `runDelivered` does both in one call,
  but only the durable (Cloudflare) runtime implements it; on the native runtime it is
  `undefined` (checked on 0.2.0-dev.49 and dev.65).
- `ChannelPolicy.denyTools` narrows tools per channel.

Two pull requests already build on this. #25 loads `prompts/skills/*.md` through
`read_skill` (first skill: `channel-digest`) and keeps skills as reviewed repo files,
never Slack messages, so nobody in a channel can plant instructions the agent follows.
#26 adds `write-a-skill`, which turns a thread into a draft skill that still lands only
through a reviewed pull request.

## Decision

### 1. A profile is a Lorehouse type, wired to June only in `src/app.ts`

ADR 0001 keeps tools, policy, prompts and the knowledge store free of June's session
internals. Profiles follow the same rule: Lorehouse defines the type, and `app.ts`
turns each profile into a `defineAgent`.

| field | meaning |
|---|---|
| `id` | durable agent id: names its sessions and sandboxes. Never the display name. A lowercase handle, `[a-z][a-z0-9-]{0,31}`, like the agent name, so it is valid in a sandbox id as is |
| `mode` | `interactive`, `automation` or `job` (§3) |
| `prompt` | `prompts/profiles/<id>.md`, embedded like every prompt |
| `tools` | picked from Lorehouse's tool catalog by name |
| `skills` | picked from the skill catalog by name (§4) |
| `triggers` | what starts a turn: Slack mentions and follow-ups, a webhook, a schedule. A webhook trigger verifies the provider's signature before any session exists, and derives the turn id from the verified delivery id (GitHub's `X-GitHub-Delivery`), so a redelivered event resumes or is dropped, never runs twice |
| `delivery` | where an automation or job turn posts its result: a rule that resolves each trigger to a June `DeliveryTarget` (channel, optional thread), e.g. "the thread that asked for this PR, else this channel". Every target must be an allowlisted public channel (§6); an unresolvable one fails the turn, it never falls back to a DM |
| `sandbox` | `none`, `read` or `write`. Only `write` may open a pull request |
| `credentials` | which grants it may ask for, e.g. GitHub read or write, per repo |
| `knowledge` | which sources it may search. Default: every allowlisted public channel |
| `model` | default model, overridable per install |

The existing agent becomes the first profile. Its id stays `lorehouse`, so no existing
session or sandbox is orphaned.

### 2. One identity in Slack

People see one agent, `scout` or whatever the install names it. Several profiles never
means several Slack bots: each would need its own Slack app, people would have to guess
whom to ask, and what one teaches would not reach the others.

So **at most one profile per install is started by Slack messages**: the interactive
one. Automation and job profiles are started by something else (a webhook, a schedule)
and post into Slack under the same identity, through the Slack channel's `post` or
`deliver`. This avoids routing Slack events between profiles for now. If two
profiles ever need to answer Slack messages, routing is decided then, in its own ADR.

### 3. Three modes

| mode | started by | session | example |
|---|---|---|---|
| `interactive` | a mention, then follow-ups in the thread | durable, one per thread | today's agent |
| `automation` | an outside event, e.g. a GitHub webhook | durable, one per subject (a PR, an issue) | review a pull request, post to its thread |
| `job` | a schedule or a command | short-lived; the result is posted, the session may be dropped | a weekly digest |

Automation and job turns start with a `ProactiveTrigger` whose `by` names the trigger
(`github:pull_request`, `schedule:weekly-digest`). That keeps "who started this" in the
session log. Where the result goes is the profile's `delivery`, resolved
when the trigger fires, not chosen by the model.

### 4. Skills: June loads them, Lorehouse decides which exist

- **Mechanism (June)**: the `Skill` format and `read_skill`.
- **Built-in skills (Lorehouse)**: `prompts/skills/*.md`, embedded, reviewed in pull
  requests (#25).
- **An install's own skills**: files in a directory the install names (`SKILLS_DIR`),
  read at start. They go through whatever review that directory has: for a git checkout,
  its pull requests. A name defined both here and among the built-ins fails startup;
  neither source shadows the other. Lorehouse never loads a skill from a Slack message. `write-a-skill`
  (#26) drafts one; a person, or the agent behind an Approve, commits it.
- **Per profile**: a profile lists the skills it gets. A skill it doesn't list is not in
  its index and `read_skill` refuses it.
- Loading skills from a git repo directly, and an agent updating skills on its own, are
  deferred.

### 5. What belongs in June, and what in Lorehouse

One rule: **a capability that needs nothing from Lorehouse goes to June. One that needs
Lorehouse's knowledge, sandbox, public-channel policy or identity stays here.**

June: the agent loop, durable turns, approval gates, the skill format and `read_skill`,
channels and triggers.
Lorehouse: the profile type, the knowledge store and ingest, the sandbox and its
runners, credentials, the public-channel policy, identity and attribution, the
conformance suite.

Gaps found on the way are filed against June rather than worked around for good. Known
now: `accept` is synchronous, so it can't look up whether a channel is private
(`src/policy.ts`). The `AnthropicClient` cast in `src/app.ts` is a dev.49 workaround for
junebuild/june#195, already fixed in June; it goes with the upgrade (#38).

### 6. Rules no profile can change

These are Lorehouse's position, not settings:

- It works only in public channels; private channels and group DMs stay shut. A DM is
  never knowledge, and is answered at all only where the install's `DM_MODE` allows it,
  from public knowledge and without code tools. A profile can't loosen that.
- A pull request opens only after a person approves it in the thread.
- People are named as plain text, never @-mentioned.
- Answers cite their sources.

A profile can narrow its tools, knowledge and credentials. It cannot widen past these.

One more rule is decided here but **not enforced yet**: a write token never enters a
sandbox. Today `open_pull_request` still pushes from inside the sandbox with the write
token in the command's environment (`src/tools/pull-request.ts`). #31 and #32 move the
push to the sandbox host; the rule holds once they land. Until then the `lorehouse`
profile keeps today's in-sandbox push, and no new profile with `sandbox: write` ships.

### 7. Sessions and sandboxes are keyed by profile

A session already belongs to one agent (`runtime.session(agent, id)`). The sandbox id is
derived from the session id alone today: `sandboxId` in `src/app.ts` replaces every
character outside `[\w.-]` with `_`, because `sandboxd` accepts only
`[A-Za-z0-9_.-]`, 1–128 characters, not starting with `.` (`valid_id` in
`sandbox/host/src/vm.rs`). Two profiles working on the same thread would share a
sandbox.

From now on the sandbox id includes the profile. The `lorehouse` profile keeps today's
sanitized session id, so existing sandboxes still resolve. Every other profile's sandbox id must
fit `sandboxd`'s rules, including the 128-character limit, and must not resolve to a
sandbox another profile owns. Joining profile and session with a separator is not enough,
since sanitizing already maps `:` to `_`. The form is `<profile>-<sha256>`: the full
64-hex SHA-256 of a domain-separated input (`lorehouse-sandbox`, the profile and the
session id, each length-prefixed), and `<profile>` is never `lorehouse`. With the §1
grammar that is at most 32 + 1 + 64 characters, whatever the session id's length. A hash
makes a collision improbable, not impossible, so it is also detected: the place that
hands out sandboxes records which profile owns each id and refuses a request from any
other. Two profiles may work in
the same thread; each keeps its own session and sandbox.

### 8. Sessions persist by default

`SESSIONS_DB` defaults to `:memory:`, and `lorehouse doctor` warns about it. A durable
automation, or a turn parked on an Approve, must survive a restart. The default becomes
a file beside `LOREHOUSE_DB`. `:memory:` stays available for tests.

## Deferred

- Routing Slack messages to more than one profile (§2).
- Profiles defined at runtime, e.g. from the admin API. The first profiles are code.
- A separate credentials proxy service. A profile's `credentials` field and the sandbox
  host's publish path (#31, #32) cover the first profiles.
- Skills loaded straight from a git repo, and skills the agent changes on its own.
- Splitting profiles into separate services (still deferred by ADR 0001).

## Consequences

- The first change is a refactor with no behavior change: today's agent becomes the
  `lorehouse` profile, and every conformance scenario passes unchanged.
- The second profile proves the design. It should be an automation profile, **pull
  request review**: it exercises a non-Slack trigger, delivery into a thread, a read-only
  sandbox and narrower credentials. A digest job would prove less.
- Conformance gains a profile dimension: each profile has its own scenarios, and the §6
  rules are checked once per profile.
- `GET /status` lists the profiles and their triggers.
- Before the first profile change, Lorehouse moves from June 0.2.0-dev.49 to the
  current dev release (0.2.0-dev.65 on 2026-10-10), and the parts listed in Context are
  re-checked there.
