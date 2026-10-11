import { describe, expect, test } from "bun:test";
import type { Channel, ChannelContext } from "@junejs/core/agent-config";
import type { TurnEvent } from "@junejs/core/agent-runtime";
import { mentionedUserIds, mentionStream, neutralizeMentions } from "../src/mentions";
import { mentionGuard, withoutMentions } from "../src/slack-guard";

// Anything Slack might read as a mention or a broadcast, well-formed or not, or as a
// bare broadcast word. (Other `<!…>` forms, such as `<!date^…>`, are formatting.)
const LIVE = /<(?:@|!(?:channel|here|everyone|group|subteam))[^>]*>|(?<![\p{L}\p{N}_])@(?:here|channel|everyone)(?![\p{L}\p{N}_])/iu;
const J = "\u2060";
const names = (m: Record<string, string>) => (id: string) => m[id];

describe("neutralizeMentions", () => {
  test("broadcasts become plain @channel, @here, @everyone, with or without a label", () => {
    expect(neutralizeMentions("hey <!channel> and <!here|here> and <!everyone>")).toBe("hey @\u2060channel and @\u2060here and @\u2060everyone");
    expect(neutralizeMentions("<!CHANNEL> <!Here>")).toBe("@\u2060channel @\u2060here");
    expect(neutralizeMentions("legacy <!group>")).toBe("legacy @\u2060group");
  });

  test("a person becomes their name when known, else Slack's label, else the bare id", () => {
    expect(neutralizeMentions("ask <@U2>", names({ U2: "Wendy" }))).toBe("ask @\u2060Wendy");
    expect(neutralizeMentions("ask <@U9|kai>")).toBe("ask @\u2060kai");
    expect(neutralizeMentions("ask <@U9>")).toBe("ask @\u2060U9");
    expect(neutralizeMentions("ask <@W123ABC>")).toBe("ask @\u2060W123ABC");
  });

  test("a user group becomes its handle, or @group", () => {
    expect(neutralizeMentions("<!subteam^S1|@launch-crew> please")).toBe("@\u2060launch-crew please");
    expect(neutralizeMentions("<!subteam^S1> please")).toBe("@\u2060group please");
  });

  test("a name can't carry markup of its own", () => {
    expect(neutralizeMentions("<@U2>", names({ U2: "<!channel>" }))).not.toMatch(LIVE);
    expect(neutralizeMentions("<@U2|<!here>>")).not.toMatch(LIVE);
  });

  test("pieces left by one rewrite never join into a new mention", () => {
    for (const s of ["<<!here>@U1>", "<<@U1>!channel>", "<<<!here>!here>!channel>", "<!sub<!here>team^S1>", "<<!subteam^S1|@>U1>"]) {
      expect(neutralizeMentions(s)).not.toMatch(LIVE);
    }
  });

  test("channel links, URLs, dates and plain text pass unchanged", () => {
    const s = "see <#C1|general> and <https://x.example/a|the doc>, due <!date^1700000000^{date}|Nov 14>; 3 < 4 > 2, a@b.c";
    expect(neutralizeMentions(s)).toBe(s);
  });

  test("a bare @here, @channel or @everyone the model writes itself is broken too, as a whole word only", () => {
    expect(neutralizeMentions("heads up @here and @Channel, @EVERYONE!")).toBe(`heads up @${J}here and @${J}Channel, @${J}EVERYONE!`);
    expect(neutralizeMentions("(@here) @here's")).toBe(`(@${J}here) @${J}here's`);
    // Not whole words, or after a letter, digit or "/": an email address, a handle, a URL.
    const s = "mail ops@here.example or x@channel, see @heredity @channels https://h.example/@everyone a1@here";
    expect(neutralizeMentions(s)).toBe(s);
  });

  test("its output is a fixpoint: guarding twice changes nothing", () => {
    for (const s of ["<!channel> @here <@U2|w> <!subteam^S1|@crew> a@b.c"]) {
      const once = neutralizeMentions(s);
      expect(neutralizeMentions(once)).toBe(once);
    }
  });

  test("lists the people mentioned, once each", () => {
    expect(mentionedUserIds("<@U1> <@U2|w> <@U1>")).toEqual(["U1", "U2"]);
  });
});

describe("mentionStream", () => {
  const run = async (pieces: string[]) => {
    const s = mentionStream((t) => neutralizeMentions(t));
    let out = "";
    for (const p of pieces) out += await s.push(p);
    return out + (await s.flush());
  };

  test("a mention split across pieces is still caught", async () => {
    expect(await run(["ping <!chan", "nel> now"])).toBe("ping @\u2060channel now");
    expect(await run(["<", "@", "U2", ">", " hi"])).toBe("@\u2060U2 hi");
    expect(await run(["a <!subteam^S1|@cr", "ew> b <!he", "re>"])).toBe("a @\u2060crew b @\u2060here");
  });

  test("a < sent just before a held mention can't join what the mention becomes", async () => {
    for (const pieces of [["<<@U", "2>>"], ["<<<@U", "2>>"], ["<<!subteam^S1|@U", "2>>"], ["a <<!here", "> b"]]) {
      const out = await run(pieces);
      expect(out).not.toMatch(LIVE);
      expect(neutralizeMentions(out)).toBe(out); // nothing left for Slack to read as a mention
    }
  });

  test("a bare broadcast split across pieces is still caught, and a split email address is not", async () => {
    expect(await run(["ping @he", "re now"])).toBe(`ping @${J}here now`);
    expect(await run(["ping @", "ever", "yone"])).toBe(`ping @${J}everyone`);
    expect(await run(["mail ops", "@here.example"])).toBe("mail ops@here.example");
    expect(await run(["see @here", "dity"])).toBe("see @heredity");
  });

  test("text goes out as it comes, holding back only an open <", async () => {
    const s = mentionStream((t) => t);
    expect(await s.push("plain words ")).toBe("plain words ");
    expect(await s.push("then <!ch")).toBe("then ");
    expect(await s.flush()).toBe("<!ch"); // never closed: not markup, so it goes out
  });

  test("a < with no > for a long stretch isn't held forever", async () => {
    const s = mentionStream((t) => t);
    const long = "x < y " + "z".repeat(200);
    expect(await s.push(long)).toBe(long);
  });
});

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
async function* from(events: TurnEvent[]): AsyncIterable<TurnEvent> {
  yield* events;
}
// Every string anywhere in a value: each is checked on its own.
const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const deltas = (events: TurnEvent[]) => events.filter((e) => e.type === "message.delta").map((e) => (e as { text: string }).text).join("");

describe("mentionGuard", () => {
  const people = async (ids: string[]) => new Map(ids.filter((id) => id === "U2").map((id) => [id, { short: "Wendy" }]));
  const g = mentionGuard(people);

  test("a turn's streamed text, final text and approval prompt reach Slack with no mention", async () => {
    const out = await collect(g.events(from([
      { type: "turn.started", turnId: "t", trigger: { kind: "message" } as never },
      { type: "message.delta", turnId: "t", text: "Ask <@U" },
      { type: "message.delta", turnId: "t", text: "2> or <!chan" },
      { type: "action.requested", turnId: "t", call: { id: "c1", name: "open_pull_request", input: {} } },
      { type: "message.delta", turnId: "t", text: "done <!here>" },
      { type: "input.requested", turnId: "t", request: { id: "pr:x", prompt: "*Open a pull request?* <!channel> by <@U2>" } as never },
      { type: "message.completed", turnId: "t", text: "<!everyone> fyi" },
      { type: "turn.completed", turnId: "t", text: "Ask <@U2> or <!channel> done <!here>" },
    ])));
    for (const s of strings(out)) expect(s).not.toMatch(LIVE);
    // "<!chan" was held across the tool call, and the text after it didn't close it.
    expect(deltas(out)).toBe("Ask @\u2060Wendy or <!chandone @\u2060here");
  });

  test("a mention split by a tool call is still caught: held text waits for the text after it", async () => {
    const out = await collect(g.events(from([
      { type: "message.delta", turnId: "t", text: "before <!ch" },
      { type: "action.requested", turnId: "t", call: { id: "c1", name: "search_knowledge", input: {} } },
      { type: "action.completed", turnId: "t", call: { id: "c1", name: "search_knowledge", input: {} }, result: "[]" },
      { type: "message.delta", turnId: "t", text: "annel> after" },
      { type: "turn.completed", turnId: "t", text: "before <!channel> after" },
    ])));
    expect(out.map((e) => e.type)).toEqual(["message.delta", "action.requested", "action.completed", "message.delta", "turn.completed"]);
    expect(deltas(out)).toBe("before @\u2060channel after");
  });

  test("the step's message.completed, which June emits before its tool call, doesn't let held text go", async () => {
    const out = await collect(g.events(from([
      { type: "message.delta", turnId: "t", text: "before <!ch" },
      { type: "message.completed", turnId: "t", text: "before <!ch" },
      { type: "action.requested", turnId: "t", call: { id: "c1", name: "search_knowledge", input: {} } },
      { type: "action.completed", turnId: "t", call: { id: "c1", name: "search_knowledge", input: {} }, result: "[]" },
      { type: "message.delta", turnId: "t", text: "annel> after" },
      { type: "turn.completed", turnId: "t", text: "annel> after" },
    ])));
    expect(deltas(out)).toBe("before @\u2060channel after");
    expect(deltas(out)).not.toMatch(LIVE);
  });

  test("text still held when the text ends goes out before what ends it", async () => {
    const out = await collect(g.events(from([
      { type: "message.delta", turnId: "t", text: "3 <" },
      { type: "turn.completed", turnId: "t", text: "3 <" },
    ])));
    expect(out.map((e) => e.type)).toEqual(["message.delta", "message.delta", "turn.completed"]);
    expect(deltas(out)).toBe("3 <");
  });

  test("the final and approval texts are named and plain", async () => {
    const out = await collect(g.events(from([
      { type: "input.requested", turnId: "t", request: { id: "pr:x", prompt: "Open it? <!channel> <@U2>" } as never },
      { type: "turn.completed", turnId: "t", text: "thanks <@U2>" },
    ])));
    expect((out[0] as { request: { prompt: string } }).request.prompt).toBe("Open it? @\u2060channel @\u2060Wendy");
    expect((out[1] as { text: string }).text).toBe("thanks @\u2060Wendy");
  });

  test("a failed name lookup still neutralizes", async () => {
    const failing = mentionGuard(async () => { throw new Error("slack down"); });
    expect(await failing.text("hi <@U2>")).toBe("hi @\u2060U2");
  });
});

describe("withoutMentions", () => {
  // A stand-in for June's Slack channel: records what it would send.
  function fakeChannel() {
    const sent: unknown[] = [];
    const channel = {
      name: "slack",
      path: "/slack/events",
      tag: "mine",
      async post(this: { tag: string }, _target: unknown, content: unknown) {
        sent.push({ tag: this.tag, content });
        return { channelId: "C1", ts: "1.1" };
      },
      async deliver(_t: unknown, events: AsyncIterable<TurnEvent>) {
        sent.push(await collect(events));
      },
      async deliverResume(_t: unknown, events: AsyncIterable<TurnEvent>) {
        sent.push(await collect(events));
      },
      async webhook(_req: Request, ctx: ChannelContext) {
        sent.push(await collect(ctx.runStream!("q")));
        sent.push(await collect(ctx.resumeStream!({ turnId: "t", inputId: "i", input: true })));
        sent.push(await ctx.run("q"));
        return new Response("ok");
      },
    };
    return { channel, sent };
  }
  const turn = (): AsyncIterable<TurnEvent> => from([{ type: "message.delta", turnId: "t", text: "hey <!channel> <@U2>" }, { type: "turn.completed", turnId: "t", text: "hey <!channel> <@U2>" }]);
  const ctx = { agent: {} as never, run: async () => "<!here> answer", runStream: () => turn(), resumeStream: () => turn() } as ChannelContext;

  test("posted notices and redirects: text and blocks, the channel's own method still called as itself", async () => {
    const { channel, sent } = fakeChannel();
    const guarded = withoutMentions(channel as unknown as Channel);
    expect(guarded).toBe(channel as unknown as Channel); // in place: a reference held to it is guarded too
    await guarded.post!({ channelId: "C1" }, "hi <!channel>, ask in <#C1>");
    const button = { type: "button", text: { type: "plain_text", text: "<!channel> ok" }, value: "<@U2>", action_id: "a" };
    await guarded.post!({ channelId: "C1" }, { text: "<@U2>", blocks: [{ type: "section", text: { type: "mrkdwn", text: "<!here>" } }, { type: "actions", elements: [button] }] });
    expect(sent).toEqual([
      { tag: "mine", content: "hi @\u2060channel, ask in <#C1>" },
      {
        tag: "mine",
        content: {
          text: "@\u2060U2",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "@\u2060here" } },
            // A button's label is shown, so guarded; its value is data handed back, untouched.
            { type: "actions", elements: [{ ...button, text: { type: "plain_text", text: "@\u2060channel ok" } }] },
          ],
        },
      },
    ]);
  });

  test("turns rendered from the webhook's context, or delivered, carry no mention", async () => {
    const { channel, sent } = fakeChannel();
    const guarded = withoutMentions(channel as unknown as Channel, async () => new Map([["U2", { short: "Wendy" }]]));
    await guarded.webhook!(new Request("http://x/slack/events"), ctx);
    await guarded.deliver!({ channelId: "C1" }, turn());
    await guarded.deliverResume!({ channelId: "C1", messageTs: "1.1" }, turn());
    expect(sent).toHaveLength(5);
    for (const s of strings(sent)) expect(s).not.toMatch(LIVE);
    expect(JSON.stringify(sent)).toContain("hey @\u2060channel @\u2060Wendy");
    expect(sent[2]).toBe("@\u2060here answer");
  });
});
