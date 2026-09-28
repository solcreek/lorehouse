// What this site stores and why. Keep it in step with app/_actions.ts and
// db/migrations/: every stored field is named here.
export const prerender = true;

// A page with no loader can't serve .json (junebuild/june#225); /privacy.md covers agents.
export const json = false;

export const metadata = {
  title: "Privacy",
  description: "What the Lorehouse website stores about you, why, for how long, and how to have it removed.",
};

const CONTACT = "privacy@creek.dev";
const UPDATED = "2026-09-28";

// The agent-facing version at /privacy.md: the same notice, as Markdown.
export const md = () => `# Privacy

Updated ${UPDATED}. This covers the Lorehouse website only. Lorehouse itself runs on
your own infrastructure and stores its data there, not with us.

## What we store

If you ask for early access, we store:

- **Your email address**, lowercased, and **when you signed up**. We use it to send you
  one email when hosted Lorehouse opens. We don't share or sell it, and we don't add
  you to anything else.
- **A counter of sign-up attempts per hour**, keyed by a one-way hash (SHA-256) of your
  IP address, never the address itself. It stops one source from flooding the list.
  Counters are deleted after a day.

That's all. The site sets no cookies and runs no analytics scripts.

## Who handles it

The site is run by SolCreek, Inc. It is served through Creek on Cloudflare, which
processes requests (including your IP address) to deliver the page, as any web host
does.

## Removal

Write to ${CONTACT} from the address you signed up with, and we'll delete it. We'll
also delete the whole list once we've sent the launch email.
`;

export default function Privacy() {
  return (
    <div className="wrap">
      <nav>
        <a className="brand" href="/"><b>Lorehouse</b><span>by SolCreek</span></a>
        <div className="navlinks">
          <a href="/">Home</a>
        </div>
        <div className="dwg"><span>DWG NO. LH-0002</span><span>PRIVACY · {UPDATED}</span></div>
      </nav>

      <article className="doc">
        <p className="label">Privacy</p>
        <h1>What we keep, and for how long</h1>
        <p className="lede">
          This covers the Lorehouse website only. Lorehouse itself runs on your own infrastructure and stores its data
          there, not with us.
        </p>

        <h2>What we store</h2>
        <p>If you ask for early access, we store:</p>
        <ul>
          <li>
            <b>Your email address</b>, lowercased, and <b>when you signed up</b>. We use it to send you one email when
            hosted Lorehouse opens. We don't share or sell it, and we don't add you to anything else.
          </li>
          <li>
            <b>A counter of sign-up attempts per hour</b>, keyed by a one-way hash (SHA-256) of your IP address, never
            the address itself. It stops one source from flooding the list. Counters are deleted after a day.
          </li>
        </ul>
        <p>That's all. The site sets no cookies and runs no analytics scripts.</p>

        <h2>Who handles it</h2>
        <p>
          The site is run by SolCreek, Inc. It is served through Creek on Cloudflare, which processes requests
          (including your IP address) to deliver the page, as any web host does.
        </p>

        <h2>Removal</h2>
        <p>
          Write to <code className="addr">{CONTACT}</code> from the address you signed up with, and we'll delete it.
          We'll also delete the whole list once we've sent the launch email.
        </p>

        <p className="updated">Updated {UPDATED}.</p>
      </article>
    </div>
  );
}
