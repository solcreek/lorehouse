# Positioning

Status: draft, 2026-09-27. The source for the website, the README's opening, and anything
else that says what Lorehouse is. Change this first; the copy follows.

## One line

**Lorehouse is your company's brain, working in public.** It answers from what the company
already knows, turns decisions into shipped code, and learns from every thread.

## Mission

Make what a company knows findable and citable by everyone, and make the work AI does for
the company happen where everyone can see it and learn from it.

## Vision

A company's collective memory that answers, acts, and improves itself. Every question
asked in public leaves the company a little smarter for the next person, and Lorehouse
keeps its lore in order while the team sleeps.

## Who it's for

1. **Now:** tech leads and founders of 20–200 person teams that already work in Slack and
   will self-host. They want an agent that knows their company, not a generic assistant.
2. **Now:** open-source contributors who care how an agent is built and tested.
3. **Later (hosted):** companies that want the same thing without running it.

## The belief

A private agent is only as good as the one person using it. An agent that works in public
channels gets better with everyone: one person's hard-won answer becomes the next person's
starting point, and anyone watching a thread can step in and correct it. So Lorehouse
works in public channels by default, and says no to private ones.

## What it does: five pillars

Each pillar carries a status: **built** (runs today), **under construction**, or
**proposed**. The website draws them as solid, hatched and dashed lines. Nothing is
described in the present tense until it runs.

| pillar | what it means | status |
|---|---|---|
| **Knows** | Answers from company knowledge, with a citation for every claim: Slack history now; repos, knowledge bases, databases, APIs and MCP servers next | Slack: built · repos, MCP: under construction · DB, API: proposed |
| **Builds** | When a discussion reaches a decision, opens the Linear or GitHub issue, writes the change in its own sandbox, runs the tests, and opens a pull request a human approves in the thread | sandbox, PR: built · issues: under construction |
| **Connects** | Sends and receives email, and gains new capabilities through connections (MCP, OpenAPI) whose credentials the model never holds | proposed |
| **Shows up** | Works in Slack and other channels. Its own web app, **the Lorehouse app**, is where the lore, the sessions and the settings live | Slack: built · the app: proposed · chat in the app: later |
| **Keeps learning** | Runs routines on a schedule, leaves lore behind after each session, and dreams: consolidates what it learned while nobody is asking | proposed |

## Principles

1. **Public by default.** It works in public channels. A DM gets pointed to one; private
   channels stay shut.
2. **Show your work.** Every answer cites its source. When nothing turns up, it says so
   and doesn't guess.
3. **Humans approve.** Code reaches a pull request only after a person approves it in
   the thread.
4. **Quiet by design.** It names people and doesn't @-mention them. Asking about someone
   never pings them.
5. **Your data stays yours.** Open source and self-hosted. Its data is plain SQL in your
   own database, and its behavior is pinned by a black-box conformance suite.

## What it is not

- Not a private assistant or a DM bot.
- Not a new chat app to move your team into. It joins the conversation you already have.
- Not enterprise search that reads everything it can reach. It reads what's public and
  what you connect.

## Vocabulary

Use these words the same way in the product, docs and site.

| word | meaning |
|---|---|
| **lore** | what the company knows and what Lorehouse has learned: indexed threads, docs, and the notes it leaves after a session |
| **the Lorehouse app** | Lorehouse's own web app: browse lore, review sessions, manage routines and connections. Not "the house": the name would blur with the blueprint visuals |
| **the agent** | the named teammate people talk to; `scout` by default, renamed per install |
| **sandbox** | the agent's own Linux machine, one per thread, where it runs code |
| **connection** | an external system the agent can use: an MCP server, an API, a knowledge base, email |
| **routine** | work the agent does on a schedule, without being asked |
| **dreaming** | offline consolidation: merging, correcting and pruning lore between sessions |

## Brand

- **Lorehouse**, one word. An independent brand, signed **by SolCreek**.
- The name carries the idea: a house that keeps a company's lore.
- Voice: plain, specific, a little warm. Show the thread rather than describe the magic.
- The blueprint is a visual language, not a copy device. Labels say literally what
  things are: "What it does", not "five rooms"; "Now / Next / Later", not
  "Foundation / Framing". Test: a reader skimming, who never notices the metaphor,
  understands every line. The linework may carry meaning (solid, hatched, dashed = built,
  under construction, proposed) because the product is really being built.
- Visual direction: a 1960s engineering drawing (B612 lettering, black ink, one
  International Orange), with notes in non-photo-blue pencil for the team's own asides.

## Proof we owe before we claim it

- ~~A `LICENSE` file.~~ MIT, added 2026-09-27.
- Real screenshots and a recorded thread. No mocked metrics, logos or testimonials.
- Dogfooding: Lorehouse opening pull requests on its own repo. Once it has, the site can
  count them (commits carrying the agent's `Co-authored-by` trailer). Today that count is
  zero.
