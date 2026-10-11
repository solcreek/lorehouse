// mentions.ts — nothing the agent posts can ping anyone.
//
// Slack turns `<@U…>` into a mention of that person and `<!channel>`, `<!here>`,
// `<!everyone>` and `<!subteam^S…>` into a broadcast. The agent must never send those
// (ADR 0002 §6: no profile can change it), and the system prompt saying so isn't a
// guarantee: knowledge holds such text whenever someone typed it literally (Slack sends
// it escaped, and cleanSlackText unescapes it), so a model quoting a source faithfully
// would ping the channel. This rewrites each one as plain text that keeps the name:
// `<@U2>` → "@Wendy" (or the label Slack gave, or the id), `<!here>` → "@here",
// `<!subteam^S1|@oncall>` → "@oncall". Plain "@here" is text: a bot's message mentions
// only through the `<…>` forms. Channel links (`<#C…>`) and URLs are left alone.

const USER = /<@([A-Za-z0-9]+)(?:\|([^>]*))?>/gi;
// `<!group>` is Slack's legacy @channel for what were private groups.
const BROADCAST = /<!(channel|here|everyone|group)(?:\|[^>]*)?>/gi;
const GROUP = /<!subteam\^([A-Za-z0-9]+)(?:\|([^>]*))?>/gi;
const OPENER = /<(?=@|!(?:channel|here|everyone|group|subteam))/gi;

// A name as plain text: no angle brackets, so it can't open a mention of its own.
const plain = (s: string) => s.replace(/[<>]/g, "").trim();
const at = (s: string) => `@${plain(s).replace(/^@+/, "")}`;

// Every user id `text` mentions, for looking their names up first.
export function mentionedUserIds(text: string): string[] {
  return [...new Set([...text.matchAll(USER)].map((m) => m[1]!))];
}

// `text` with every mention and broadcast rewritten as plain text. `names` gives a user
// id's name, when known.
export function neutralizeMentions(text: string, names: (id: string) => string | undefined = () => undefined): string {
  // Until nothing changes: a rewrite must not leave pieces that join into a new mention.
  // Each pass that changes anything removes at least one "<", so this ends.
  for (;;) {
    const next = text
      .replace(USER, (_, id: string, label?: string) => at(names(id) || label || id))
      .replace(BROADCAST, (_, which: string) => `@${which.toLowerCase()}`)
      .replace(GROUP, (_, _id: string, label?: string) => at(label || "group"))
      // An opener left malformed ("<@here@U1>") is not trusted to stay inert in Slack's
      // parser either: its "<" goes.
      .replace(OPENER, "");
    if (next === text) return text;
    text = next;
  }
}

// A streamed text, guarded piece by piece. A mention can arrive split across pieces
// ("<!chan" then "nel>"), so an unclosed `<` at the end of a piece is held back until
// the piece that closes it, or until `flush`. Held text is short: a `<` with no `>`
// within MAX_HELD characters isn't Slack markup, and goes out as it is.
const MAX_HELD = 120;

export function mentionStream(guard: (text: string) => string | Promise<string>) {
  let held = "";
  return {
    // The part of `piece` (with what was held before it) that can go out now.
    async push(piece: string): Promise<string> {
      const s = held + piece;
      const open = s.lastIndexOf("<");
      if (open >= 0 && !s.includes(">", open) && s.length - open <= MAX_HELD) {
        held = s.slice(open);
        return s.slice(0, open) ? guard(s.slice(0, open)) : "";
      }
      held = "";
      return s ? guard(s) : "";
    },
    // What is still held, guarded: before any other event, and at the end.
    async flush(): Promise<string> {
      const s = held;
      held = "";
      return s ? guard(s) : "";
    },
  };
}
