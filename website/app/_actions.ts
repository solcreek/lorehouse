// One definition, two callers: the early-access form posts it through /mcp, and an
// agent can call the same tool there.
import { defineAction } from "@junejs/core/agent";
import { db } from "@junejs/db";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const joinEarlyAccess = defineAction({
  id: "join_early_access",
  description:
    "Add a work email to the list of people told when hosted Lorehouse opens. Adding the same email twice is harmless.",
  input: {
    type: "object",
    properties: { email: { type: "string", description: "A work email address" } },
    required: ["email"],
  },
  async run({ email }) {
    const address = email.trim().toLowerCase();
    if (address.length > 254 || !EMAIL.test(address)) {
      throw new Error("That doesn't look like an email address. Check it and try again.");
    }
    await db.run("INSERT INTO early_access (email) VALUES (?) ON CONFLICT (email) DO NOTHING", [address]);
    return { ok: true };
  },
});
