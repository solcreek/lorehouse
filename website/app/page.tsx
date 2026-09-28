// The landing page. Prerendered at build time; the early-access form is its only island.
// Copy follows docs/positioning.md: the blueprint is the look, and every label says
// literally what it is.
import { EarlyAccess } from "./EarlyAccess";
import { SystemDrawing } from "./SystemDrawing";
import "./_actions";

const REPO = "https://github.com/solcreek/lorehouse";

export const prerender = true;

export const metadata = {
  title: "Your company's brain, working in public",
  description:
    "Lorehouse answers from what your company already knows, turns decisions into shipped code, and learns from every thread. Open source, self-hosted, pre-alpha.",
};

// What an agent reads at /index.md: the same page, without the drawing.
export const md = () => `# Lorehouse: your company's brain, working in public

Lorehouse answers from what your company already knows, turns decisions into shipped
code, and learns from every thread. Open source and self-hosted. Status: pre-alpha, not
ready for production.

## Why it only works in public

A private agent is only as good as the person typing. An agent that works in public
channels gets better with everyone who watches, corrects and builds on it.

## What it does, and what runs today

| capability | built | under construction | proposed |
|---|---|---|---|
| Knows: answers from company knowledge, with citations | Slack history | repos, MCP servers | databases, APIs, wikis |
| Builds: issue, code in a sandbox, pull request a person approves | sandbox, approved PRs | issues from threads | |
| Connects: email and connections whose credentials the model never holds | | | email, MCP and OpenAPI connections |
| Shows up: in the chat you already use, plus its own app | Slack | | other chat tools, the Lorehouse app |
| Keeps learning: routines, saved lore, dreaming | | saving what it learned | routines, dreaming |

## Principles

1. Public by default. A DM gets pointed to a public channel; private channels stay shut.
2. Shows its work. Every answer links to where it came from.
3. People approve. Code becomes a pull request only after a person approves it in the thread.
4. Quiet by design. It names people but never @-mentions them.
5. Yours to keep. Self-hosted, with its data in plain SQL in your own database.

## What it reads

Reads: threads in the public channels you allow, seed documents you give it, the repos
and connections you add. Never reads: private channels, group DMs, direct messages (it
can reply to one but never indexes it), or messages after they're deleted.

## Get it

- Source: ${REPO}
- Early access to hosted Lorehouse: call the \`join_early_access\` tool at /mcp.
`;

// What an agent reads at /index.json. June 0.1 can't serialize a page with no loader,
// so the structured version is spelled out.
export const json = () => ({
  name: "Lorehouse",
  tagline: "Your company's brain, working in public.",
  status: "pre-alpha",
  source: REPO,
  capabilities: CAPABILITIES.map((c) => ({
    name: c.title,
    description: c.body,
    built: c.status.filter(([s]) => s === "b").map(([, t]) => t),
    underConstruction: c.status.filter(([s]) => s === "w").map(([, t]) => t),
    proposed: c.status.filter(([s]) => s === "p").map(([, t]) => t),
  })),
  earlyAccess: { mcpTool: "join_early_access", endpoint: "/mcp" },
});

function Balloon({ n }: { n: number }) {
  return <span className="bal">{n}</span>;
}

function Status({ kind, children }: { kind: "b" | "w" | "p"; children: React.ReactNode }) {
  return (
    <div className="st">
      <i className={`sw ${kind}`} />
      <span>{children}</span>
    </div>
  );
}

function Zones() {
  const cols = ["12.5%", "37.5%", "62.5%", "87.5%"];
  const rows = ["25%", "50%", "75%"];
  return (
    <div className="zones" aria-hidden="true">
      {cols.map((left, i) => <span key={`t${i}`} className="t" style={{ left }}>{i + 1}</span>)}
      {cols.map((left, i) => <span key={`b${i}`} className="b" style={{ left }}>{i + 1}</span>)}
      {rows.map((top, i) => <span key={`l${i}`} className="l" style={{ top }}>{"ABC"[i]}</span>)}
      {rows.map((top, i) => <span key={`r${i}`} className="r" style={{ top }}>{"ABC"[i]}</span>)}
    </div>
  );
}

function Hero() {
  return (
    <div className="sheet">
      <Zones />
      <header className="hero">
        <div>
          <p className="label">Open source · self-hosted</p>
          <h1 style={{ marginTop: 16 }}>
            Your company's brain, working <em>in public.</em>
          </h1>
          <div className="aside">
            <svg viewBox="0 0 46 34" aria-hidden="true">
              <path d="M40 4 C 30 8, 14 12, 8 28 M2 21 L8 29 L15 23" style={{ filter: "url(#pencil)" }} />
            </svg>
            <span className="hand">the one rule: it only works in public channels</span>
          </div>
          <p className="lede">
            It answers from what your company already knows, turns decisions into shipped code, and learns from every thread.
          </p>
          <div className="ctas">
            <a className="btn primary" href={REPO}>Star on GitHub</a>
            <a className="btn" href="#early">Get early access</a>
          </div>
          <div className="hero-foot">
            <p className="cmd">Self-host: <code>bun install &amp;&amp; bun start</code></p>
            <span className="stamp" aria-label="Pre-alpha. Not ready for production.">
              <span>Pre-alpha<br />Not ready for production</span>
            </span>
          </div>
        </div>

        <figure className="thread" aria-label="Example Slack thread, annotated">
          <div className="thead"><span># eng-billing</span><span className="ex">Fig. 1 · example thread</span></div>
          <div className="msgs">
            <div className="msg">
              <div className="av">M</div>
              <div>
                <div className="who">Maya Chen <small>10:02</small></div>
                <p>@scout why do invoice retries stop after three attempts? Is that on purpose?</p>
              </div>
            </div>
            <div className="msg">
              <div className="av s">s</div>
              <div>
                <div className="who">scout <span className="bot">AGENT</span><small>10:02</small></div>
                <p>
                  Yes. #billing decided it on June 12: three retries, then the invoice goes to manual review, because a fourth
                  retry was tripping card-issuer fraud flags. Tomás Ruiz made the change.{" "}
                  <span className="cite">#billing · Jun 12 ↗</span><Balloon n={1} />
                </p>
              </div>
            </div>
            <div className="msg">
              <div className="av">T</div>
              <div>
                <div className="who">Tomás Ruiz <small>10:05</small></div>
                <p>Right. We should email the customer before it hits manual review, though. @scout can you take that?</p>
              </div>
            </div>
            <div className="msg">
              <div className="av s">s</div>
              <div>
                <div className="who">scout <span className="bot">AGENT</span><small>10:05</small></div>
                <p>Opened <span className="cite">ENG-412</span><Balloon n={2} /> and started in my sandbox.</p>
                <div className="steps">
                  git clone acme/billing<br />
                  edit src/billing/retry.ts, src/email/templates/review.tsx<br />
                  bun test billing … <b>48 passed</b> <Balloon n={3} />
                </div>
                <div className="approve">
                  <p>Open a pull request from <code>scout/email-before-review</code>?</p>
                  <div className="row">
                    <span className="chip go">Approve</span><span className="chip">Deny</span>
                    <span className="by">Maya Chen approved</span><Balloon n={4} />
                  </div>
                </div>
                <div className="lore">
                  <span className="label">Lore saved</span>
                  <span>Invoice retries: 3, then manual review. The customer is emailed first (ENG-412).</span>
                  <Balloon n={5} />
                </div>
              </div>
            </div>
          </div>
          <figcaption className="keys">
            <div><Balloon n={1} />cites where it read that</div>
            <div><Balloon n={2} />opens the issue</div>
            <div><Balloon n={3} />codes in its own sandbox</div>
            <div><Balloon n={4} />a person approves the PR</div>
            <div><Balloon n={5} />remembers for next time</div>
            <div className="foot">Illustration. 1, 3 and 4 run today. 2 and 5 are under construction.</div>
          </figcaption>
        </figure>
      </header>
    </div>
  );
}

function SectionHead({ no, title, children }: { no: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="shead">
      <div><span className="no">{no}</span><h2>{title}</h2></div>
      {children && <p>{children}</p>}
    </div>
  );
}

const CAPABILITIES: { title: string; body: string; status: ["b" | "w" | "p", string][] }[] = [
  {
    title: "Knows",
    body: "Answers from your company's Slack history and cites every claim. When nothing turns up, it says so and doesn't guess. Repos and MCP servers come next.",
    status: [["b", "Slack history"], ["w", "Repos, MCP servers"], ["p", "Databases, APIs, wikis"]],
  },
  {
    title: "Builds",
    body: "Writes the change in its own sandbox, runs the tests, and opens a pull request once a person approves it. Next: opening the Linear or GitHub issue from the thread.",
    status: [["b", "Sandbox, approved PRs"], ["w", "Issues from threads"]],
  },
  {
    title: "Connects",
    body: "Planned: sending and reading email, and new abilities through connections whose credentials the model never holds.",
    status: [["p", "Email, MCP and OpenAPI connections"]],
  },
  {
    title: "Shows up",
    body: "Works in Slack, where your team already talks. Planned: other chat tools, and an app of its own for everything it knows.",
    status: [["b", "Slack"], ["p", "Other chat tools, the Lorehouse app"]],
  },
  {
    title: "Keeps learning",
    body: "Next: saving what it learned after each session. Planned: routines on a schedule, and reviewing what it learned overnight.",
    status: [["w", "Saving what it learned"], ["p", "Routines, dreaming"]],
  },
];

function WhatItDoes() {
  return (
    <section id="what">
      <SectionHead no="02 · What it does" title="What it does, and what runs today">
        The whole system on one drawing. Solid lines run today, hatched parts are being built, dashed parts are designed but
        not built.
      </SectionHead>
      <div className="drawing">
        <div className="scroll"><SystemDrawing /></div>
        <div className="foot">
          <div className="legend">
            <span><i className="sw b" />Built</span>
            <span><i className="sw w" />Under construction</span>
            <span><i className="sw p" />Proposed</span>
          </div>
          <span className="hand">dashed means not built yet. we'd rather show you than pretend.</span>
        </div>
      </div>
      <div className="caps">
        {CAPABILITIES.map((c) => (
          <div className="cap" key={c.title}>
            <h3>{c.title}</h3>
            <p>{c.body}</p>
            <div className="status">
              {c.status.map(([kind, text]) => <Status key={text} kind={kind}>{text}</Status>)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItLearns() {
  return (
    <section id="learns">
      <SectionHead no="03 · How it learns" title="Every thread makes the next answer better">
        Lore is what your company knows, plus what Lorehouse learns while working for it.
      </SectionHead>
      <ol className="loop">
        <li><div className="n">Step</div><h3>Ask in public</h3><p>Someone mentions the agent in a channel. Everyone can read along and step in.</p><Status kind="b">Built</Status></li>
        <li><div className="n">Step</div><h3>Do the work</h3><p>It searches what your company knows and codes in a sandbox of its own.</p><Status kind="b">Built</Status></li>
        <li>
          <span className="ring" aria-hidden="true" />
          <div className="n">Step</div>
          <h3>Save what it learned</h3>
          <p>What it learned will become a note the next session starts from, linked to its thread.</p>
          <Status kind="w">Under construction</Status>
          <span className="hand ringnote">this is the part that compounds</span>
        </li>
        <li><div className="n">Overnight</div><h3>Dreaming</h3><p>While nobody is asking, it will merge duplicate notes, correct what went stale and drop what turned out wrong.</p><Status kind="p">Proposed</Status></li>
      </ol>
      <p className="back">Then back to step 1</p>
    </section>
  );
}

function TheApp() {
  return (
    <section id="app">
      <SectionHead no="04 · The Lorehouse app" title="See what it knows and what it did">
        Lorehouse's own web app. It doesn't replace your chat. A chat surface comes later.
      </SectionHead>
      <div className="appsec">
        <ul>
          <li><b>Lore</b><span>Browse and correct what it knows, each note linked to its source.</span></li>
          <li><b>Sessions</b><span>Every thread it worked in, with the tools it called and the PRs it opened.</span></li>
          <li><b>Routines</b><span>Work it does on a schedule, like a Monday digest or the nightly review.</span></li>
          <li><b>Connections</b><span>Repos, knowledge bases, databases, APIs, MCP servers and email.</span></li>
        </ul>
        <div className="wire-app" aria-label="Wireframe of the Lorehouse app">
          <span className="sticky">sketch, not a screenshot. proposed.</span>
          <div className="bar"><span>Lorehouse app / Lore</span><span>Wireframe</span></div>
          <div className="body">
            <aside><span className="on">Lore</span><span>Sessions</span><span>Routines</span><span>Connections</span></aside>
            <main>
              <div className="search">Search lore: invoice retries</div>
              <div className="card">
                <h4>Invoice retries</h4>
                <p>Three retries, then manual review. The customer is emailed before review starts.</p>
                <div className="meta"><span>#eng-billing thread</span><span>ENG-412</span><b>updated overnight</b></div>
              </div>
              <div className="card">
                <h4>Who owns billing</h4>
                <p>Tomás Ruiz owns retry logic; Maya Chen owns customer email templates.</p>
                <div className="meta"><span>2 threads</span><span>cited 14 times</span></div>
              </div>
            </main>
          </div>
        </div>
      </div>
    </section>
  );
}

const PRINCIPLES = [
  ["Public by default", "It works in public channels. A DM gets pointed to one, and private channels stay shut."],
  ["Shows its work", "Every answer links to where it came from. No source, no claim."],
  ["People approve", "Code becomes a pull request only after a person approves it in the thread."],
  ["Quiet by design", "It names people but never @-mentions them, so asking about someone doesn't ping them."],
  ["Yours to keep", "Self-hosted, with its data in plain SQL in your own database."],
];

const QUICKSTART = `# point it at a public channel
SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=xoxb-… \\
ANTHROPIC_API_KEY=… AGENT_CHANNELS=C0123456 \\
bun start`;

function ForEngineers() {
  return (
    <section id="engineers">
      <SectionHead no="06 · For engineers" title="Built to be read, run and replaced">
        TypeScript on the June framework, with Firecracker sandboxes. A black-box conformance suite pins its behavior, so any
        implementation that passes it is interchangeable.
      </SectionHead>
      <div className="eng">
        <div className="facts">
          <div><b>Durable turns</b>A turn survives a restart and waits for a person's approval.</div>
          <div><b>Prompts are Markdown</b>Read and change them like any other file in the repo.</div>
          <div><b>Reads Chinese, Japanese and Korean</b>Search works on CJK text, not only on words split by spaces.</div>
          <div><b>Keeps the index truthful</b>Edits and deletions reach it, and a deleted message can't be quoted.</div>
        </div>
        <div>
          <pre>
            <span className="c">{QUICKSTART.split("\n")[0]}</span>
            {"\n" + QUICKSTART.split("\n").slice(1).join("\n")}
          </pre>
          <div className="tablewrap">
            <table className="env">
              <thead><tr><th>env</th><th>default</th><th>what</th></tr></thead>
              <tbody>
                <tr><td>AGENT_NAME</td><td>scout</td><td>The agent's handle in Slack</td></tr>
                <tr><td>DM_MODE</td><td>redirect</td><td>Point a DM to a public channel, ignore it, or answer from public knowledge</td></tr>
                <tr><td>INGEST_BACKFILL_DAYS</td><td>90</td><td>How much channel history it reads on first start</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <div className="wrap">
      <nav>
        <a className="brand" href="/" id="top"><b>Lorehouse</b><span>by SolCreek</span></a>
        <div className="navlinks">
          <a href="#what">What it does</a>
          <a href="#app">The app</a>
          <a href="#engineers">For engineers</a>
          <a href="#roadmap">Roadmap</a>
          <a href={REPO}>GitHub</a>
        </div>
        <div className="dwg"><span>DWG NO. LH-0001</span><span>REV 0 · PRE-ALPHA</span></div>
      </nav>

      <Hero />

      <section id="belief">
        <SectionHead no="01 · Why public" title="Why it only works in public" />
        <div className="belief">
          <blockquote>
            A private agent is only as good as the person typing. An agent that works <em>in public</em> gets better with
            everyone who watches, corrects and builds on it.
          </blockquote>
          <div className="compare">
            <div className="them"><h3>Private assistants</h3><p>Every answer stays in one DM. The next person asks the same question and starts from zero.</p></div>
            <div><h3>Lorehouse</h3><p>Works in public channels only. One person's hard-won answer becomes the next person's starting point, and anyone can step in to correct it.</p></div>
          </div>
        </div>
      </section>

      <WhatItDoes />
      <HowItLearns />
      <TheApp />

      <section id="principles">
        <SectionHead no="05 · Principles" title="How it behaves" />
        <div className="spec">
          {PRINCIPLES.map(([title, body], i) => (
            <div key={title}><span className="code">{String(i + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{body}</p></div>
          ))}
        </div>
      </section>

      <ForEngineers />

      <section id="trust">
        <SectionHead no="07 · What it reads" title="Know exactly what it knows" />
        <div className="trust">
          <div className="yes">
            <h3>Reads</h3>
            <ul>
              <li>Threads in the public channels you allow</li>
              <li>Seed documents you give it</li>
              <li>The repos and connections you add</li>
            </ul>
          </div>
          <div className="no">
            <h3>Never reads</h3>
            <ul>
              <li>Private channels and group DMs</li>
              <li>Direct messages. It can reply to one, but never indexes it</li>
              <li>Messages after they're deleted</li>
            </ul>
          </div>
        </div>
      </section>

      <section id="roadmap">
        <SectionHead no="08 · Roadmap" title="Now, next, later">
          Pre-alpha. It runs against real Slack, but it isn't ready for your team yet.
        </SectionHead>
        <div className="road">
          <div><div className="ph"><i className="sw b" />Built</div><h3>Now</h3><ul><li>Answers from Slack history, with citations</li><li>Sandbox coding and approved pull requests</li><li>Public-only policy and DM handling</li></ul></div>
          <div><div className="ph"><i className="sw w" />Under construction</div><h3>Next</h3><ul><li>Issues in Linear and GitHub from a thread</li><li>MCP connections and repo knowledge</li><li>Saving what it learned after each session</li></ul></div>
          <div><div className="ph"><i className="sw p" />Proposed</div><h3>Later</h3><ul><li>Email, other chat tools, the Lorehouse app</li><li>Routines and dreaming</li><li>Hosted Lorehouse</li></ul></div>
        </div>
      </section>

      <section className="cta" id="early">
        <div>
          <h2>Follow the build</h2>
          <p>Star the repo to watch it come together, or leave your email and we'll tell you when hosted Lorehouse opens.</p>
          <span className="hand">we build this in the open too.</span>
          <a className="btn gh" href={REPO}>Star on GitHub</a>
        </div>
        <EarlyAccess client:load />
      </section>

      <footer className="titleblock" aria-label="Title block">
        <div><span className="k">Project</span><span className="big">Lorehouse</span><span className="k" style={{ marginTop: 4 }}>Your company's brain, working in public</span></div>
        <div><span className="k">Made by</span><span className="v">SolCreek</span></div>
        <div><span className="k">Drawing no.</span><span className="v">LH-0001</span></div>
        <div>
          <table className="rev" aria-label="Revisions">
            <thead><tr><th>Rev</th><th>Status</th><th>Date</th></tr></thead>
            <tbody><tr><td>0</td><td>Pre-alpha</td><td>2026-09-27</td></tr></tbody>
          </table>
        </div>
      </footer>
    </div>
  );
}
