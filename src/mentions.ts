// mentions.ts — nothing the agent posts can ping anyone.
//
// Slack turns `<@U…>` into a mention of that person and `<!channel>`, `<!here>`,
// `<!everyone>` and `<!subteam^S…>` into a broadcast. The agent must never send those
// (ADR 0002 §6: no profile can change it), and the system prompt saying so isn't a
// guarantee: knowledge holds such text whenever someone typed it literally (Slack sends
// it escaped, and cleanSlackText unescapes it), so a model quoting a source faithfully
// would ping the channel. This rewrites each one as plain text that keeps the name:
// `<@U2>` → "@Wendy" (or the label Slack gave, or the id), `<!here>` → "@here",
// `<!subteam^S1|@oncall>` → "@oncall". Each rewritten "@" is followed by an invisible
// word joiner (U+2060), and so is a bare "@here", "@channel" or "@everyone" the model
// writes itself: Slack's `text` field doesn't parse bare names, but its markdown_text
// stream and mrkdwn blocks may, and "@", U+2060, "here" reads the same while matching nothing.
// An "@" after a letter, digit or "/" (an email address, a URL) is not a mention and is
// left alone, as are channel links (`<#C…>`).

const USER = /<@([A-Za-z0-9]+)(?:\|([^>]*))?>/gi;
// `<!group>` is Slack's legacy @channel for what were private groups.
const BROADCAST = /<!(channel|here|everyone|group)(?:\|[^>]*)?>/gi;
const GROUP = /<!subteam\^([A-Za-z0-9]+)(?:\|([^>]*))?>/gi;
const OPENER = /<(?=@|!(?:channel|here|everyone|group|subteam))/gi;
// A broadcast written as a bare word: not after a letter, digit or "/" (an email
// address, a URL's path).
const BARE = /(?<![\p{L}\p{N}_/])@(here|channel|everyone)(?![\p{L}\p{N}_])/giu;
// U+2060 WORD JOINER: invisible, and it keeps "@" from starting a name.
export const JOINER = "\u2060";

// A name as plain text: no angle brackets, so it can't open a mention of its own.
const plain = (s: string) => s.replace(/[<>]/g, "").trim();
const at = (s: string) => `@${JOINER}${plain(s).replace(/^[@\u2060]+/, "")}`;

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
      .replace(BROADCAST, (_, which: string) => `@${JOINER}${which.toLowerCase()}`)
      .replace(GROUP, (_, _id: string, label?: string) => at(label || "group"))
      // An opener left malformed ("<@here@U1>") is not trusted to stay inert in Slack's
      // parser either: its "<" goes.
      .replace(OPENER, "");
    if (next === text) return text.replace(BARE, (_, which: string) => `@${JOINER}${which}`);
    text = next;
  }
}

// A streamed text, guarded piece by piece. A mention can arrive split across pieces
// ("<!chan" then "nel>", or "@he" then "re"), so an unclosed `<` at the end of a piece,
// or a short "@word" there, is held back until the piece that settles it, or until
// `flush`. Held text is short: a `<` with no `>` within MAX_HELD characters isn't Slack
// markup, and goes out as it is.
const MAX_HELD = 120;
// A trailing "@" plus up to as many letters as "everyone": it may be a bare broadcast.
const TRAILING_AT = /(?<![\p{L}\p{N}_/])@[A-Za-z]{0,8}$/u;
const WORD_END = /[\p{L}\p{N}_/]$/u;

export function mentionStream(guard: (text: string) => string | Promise<string>) {
  let held = "";
  let last = ""; // the last character sent
  // Guarded with the character sent before it, so an "@" right after a letter or "/" (an
  // email address or URL split across pieces) is still read as not a mention.
  const send = async (t: string): Promise<string> => {
    if (!t) return "";
    const before = WORD_END.test(last) ? last : "";
    const out = (await guard(before + t)).slice(before.length);
    if (out) last = out.slice(-1);
    return out;
  };
  return {
    // The part of `piece` (with what was held before it) that can go out now.
    async push(piece: string): Promise<string> {
      const s = held + piece;
      let start = s.length;
      const open = s.lastIndexOf("<");
      if (open >= 0 && !s.includes(">", open) && s.length - open <= MAX_HELD) {
        // The "<"s right before it are held too: sent alone, one would join whatever the
        // held text becomes ("<" then "@U2>" from "<@U2>>" is "<@U2>" in Slack).
        start = open;
        while (start > 0 && s[start - 1] === "<") start--;
      }
      const at = TRAILING_AT.exec(s);
      if (at && !(at.index === 0 && WORD_END.test(last)) && at.index < start) start = at.index;
      held = s.slice(start);
      return send(s.slice(0, start));
    },
    // What is still held, guarded: before any other event, and at the end.
    async flush(): Promise<string> {
      const s = held;
      held = "";
      return send(s);
    },
  };
}
