"use client";
// The one island on the page. It calls the join_early_access action through /mcp:
// June 0.1 has no RSC server-action endpoint, and /mcp is the same action.
import { useState, type FormEvent } from "react";

type State = { kind: "idle" | "sending" | "done" } | { kind: "error"; message: string };

export function EarlyAccess() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    setState({ kind: "sending" });
    try {
      const res = await fetch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "join_early_access", arguments: { email } },
        }),
      });
      const body = await res.json();
      const result = body?.result;
      if (!res.ok || !result || result.isError) {
        const text: string = result?.content?.[0]?.text ?? "";
        throw new Error(text.replace(/^Error:\s*/, "") || "Something went wrong. Try again in a minute.");
      }
      setState({ kind: "done" });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (state.kind === "done") {
    return (
      <p className="done" role="status">
        You're on the list. We'll email you when hosted Lorehouse opens.
      </p>
    );
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="early-email">Work email</label>
      <div className="field">
        <input id="early-email" name="email" type="email" required placeholder="you@company.com" autoComplete="email" />
        <button type="submit" disabled={state.kind === "sending"}>
          {state.kind === "sending" ? "Adding…" : "Get early access"}
        </button>
      </div>
      <p className="note" role={state.kind === "error" ? "alert" : undefined}>
        {state.kind === "error" ? state.message : "One email when hosted Lorehouse opens. Nothing else."}
      </p>
    </form>
  );
}
