// Prompt caching for the model's requests (#193). June's anthropic() sends the system
// prompt as a string and asks for no caching, so every step of a turn paid full price for
// the same tools, system prompt and conversation so far. This marks what repeats, and
// changes nothing the model reads: the same tools, the same system text, the same messages.
//
// A request is cached as a prefix, in the order tools, system, messages. Two marks:
//   - on the system prompt: tools and system are the same for every request a process
//     makes for one profile, so every thread reads them, whatever it goes on to say;
//   - on the request itself: the API puts the mark on the last block it can cache, so each
//     step of a turn reads the conversation up to the step before it and writes its own end.
// A cached prefix lives five minutes from the last request that wrote or read it (the
// API's default). A write costs a quarter more than plain input and a read a tenth of it
// or less, by model, so a prefix read once has paid for itself. A prefix shorter than the
// model's minimum is simply not cached: no error.
// The mark on the request is the Anthropic API's own. A gateway that speaks another
// dialect (Bedrock refuses it) would need this left out; ANTHROPIC_BASE_URL has only ever
// meant the API or a mock of it.
import type Anthropic from "@anthropic-ai/sdk";

type StreamParams = Anthropic.MessageStreamParams;
type StreamOptions = Parameters<Anthropic["messages"]["stream"]>[1];
type MessageStream = ReturnType<Anthropic["messages"]["stream"]>;

const EPHEMERAL = { type: "ephemeral" } as const;

// The same request with its repeating parts marked. A request that already says how it is
// to be cached (a mark of its own on the request, or system blocks instead of a string) is
// left as its author wrote it.
export function withCacheMarks(body: StreamParams): StreamParams {
  return {
    ...body,
    ...(typeof body.system === "string" && body.system !== "" ? { system: [{ type: "text" as const, text: body.system, cache_control: EPHEMERAL }] } : {}),
    ...(body.cache_control === undefined ? { cache_control: EPHEMERAL } : {}),
  };
}

// The part of the SDK's client June calls, marking each request on its way out. `stream`
// is a method on purpose: June checks an injected client against the request it sends, and
// the real SDK's narrower parameter passes that check only as a method's.
export type MessagesClient = { messages: { stream(body: StreamParams, options?: StreamOptions): MessageStream } };

export function withPromptCaching(client: MessagesClient): MessagesClient {
  return {
    messages: {
      stream(body: StreamParams, options?: StreamOptions): MessageStream {
        return client.messages.stream(withCacheMarks(body), options);
      },
    },
  };
}
