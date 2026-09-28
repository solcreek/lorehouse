import { defineJune } from "@junejs/core/config";
import { sqlite } from "@junejs/server/db";

export default defineJune({
  site: {
    name: "Lorehouse",
    titleTemplate: "%s · Lorehouse",
    description:
      "Your company's brain, working in public. It answers from what your company already knows, turns decisions into shipped code, and learns from every thread.",
    lang: "en",
  },
  // llms.txt, /mcp and the .md/.json projections: the site serves agents as well as people.
  // The llms.txt preamble defaults to June's own package names; say ours instead.
  agent: {
    enabled: true,
    llms: {
      framework: [
        "## Project",
        "",
        "Lorehouse is an open-source company brain that works in public Slack channels. Pre-alpha.",
        "- Source: https://github.com/solcreek/lorehouse",
        "- The agent's handle defaults to `scout` and is renamed per install.",
        "- Early access to hosted Lorehouse: the `join_early_access` tool at /mcp.",
      ],
    },
  },
  // June's reset ships starter styles too (code backgrounds, a 720px <main>) even when
  // the app has its own global.css. global.css carries the reset this page needs.
  cssReset: false,
  // The early-access list. A local SQLite file in dev, D1 on Workers.
  resources: { db: sqlite() },
  deploy: { target: "workers", name: "lorehouse-website" },
});
