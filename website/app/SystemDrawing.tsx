// The whole system on one drawing. Each box's linework is its build status:
// solid = built, hatched strip = under construction, dashed = proposed.
// Rendered on the server; it ships no JavaScript.
type Status = "b" | "w" | "p";
type Column = "channel" | "schedule" | "agent" | "knowledge" | "output";
type Box = { x: number; y: number; w: number; h: number; title: string; sub: string; sub2?: string; st: Status; col: Column };

const BOXES: Box[] = [
  { x: 20, y: 60, w: 190, h: 52, title: "Slack", sub: "mentions and threads", st: "b", col: "channel" },
  { x: 20, y: 128, w: 190, h: 52, title: "Email", sub: "send and receive", st: "p", col: "channel" },
  { x: 20, y: 196, w: 190, h: 52, title: "Lorehouse app", sub: "lore and settings", st: "p", col: "channel" },
  { x: 20, y: 264, w: 190, h: 52, title: "Other chat tools", sub: "beyond Slack", st: "p", col: "channel" },
  { x: 320, y: 40, w: 120, h: 56, title: "Routines", sub: "on a schedule", st: "p", col: "schedule" },
  { x: 450, y: 40, w: 120, h: 56, title: "Dreaming", sub: "overnight", st: "p", col: "schedule" },
  { x: 320, y: 130, w: 250, h: 110, title: "Agent", sub: "answers, cites, plans", sub2: "durable turns, approvals", st: "b", col: "agent" },
  { x: 720, y: 40, w: 220, h: 46, title: "Slack history", sub: "indexed, cited", st: "b", col: "knowledge" },
  { x: 720, y: 100, w: 220, h: 46, title: "Repos", sub: "code as knowledge", st: "w", col: "knowledge" },
  { x: 720, y: 160, w: 220, h: 46, title: "MCP servers", sub: "tools and data", st: "w", col: "knowledge" },
  { x: 720, y: 220, w: 220, h: 46, title: "Databases, APIs", sub: "through connections", st: "p", col: "knowledge" },
  { x: 720, y: 280, w: 220, h: 46, title: "Saved lore", sub: "notes after each session", st: "w", col: "knowledge" },
  { x: 20, y: 350, w: 190, h: 52, title: "Issues", sub: "Linear, GitHub", st: "w", col: "output" },
  { x: 350, y: 350, w: 190, h: 56, title: "Sandbox", sub: "clone, edit, test", st: "b", col: "output" },
  { x: 720, y: 352, w: 220, h: 52, title: "Pull request", sub: "after a person approves", st: "b", col: "output" },
];

const LABEL =
  "System drawing. Channels: Slack is built; email, the Lorehouse app and other chat tools are proposed. " +
  "The agent is built; routines and dreaming are proposed. Knowledge: Slack history is built; repos, MCP servers " +
  "and saved lore are under construction; databases and APIs are proposed. The agent opens issues (under " +
  "construction) and works in an isolated sandbox (built) that produces a pull request after a person approves (built).";

function Wire({ d, dashed = false }: { d: string; dashed?: boolean }) {
  return <path className={dashed ? "wire p" : "wire"} d={d} markerEnd="url(#ah)" />;
}

function wireFor(b: Box) {
  const mid = b.y + b.h / 2;
  if (b.col === "channel") return <Wire key={b.title} d={`M${b.x + b.w} ${mid} H265 V185 H318`} dashed={b.st === "p"} />;
  if (b.col === "knowledge") return <Wire key={b.title} d={`M570 185 H645 V${mid} H718`} dashed={b.st === "p"} />;
  if (b.col === "schedule") return <Wire key={b.title} d={`M${b.x + b.w / 2} 96 V128`} dashed />;
  return null;
}

function BoxShape({ b }: { b: Box }) {
  const textX = b.st === "w" ? b.x + 20 : b.x + 14;
  const titleY = b.col === "agent" ? b.y + 40 : b.y + b.h / 2 - 3;
  return (
    <g>
      <rect className={`bx ${b.st}`} x={b.x} y={b.y} width={b.w} height={b.h} />
      {b.st === "w" && <rect className="strip" x={b.x} y={b.y} width={9} height={b.h} />}
      <text className="t" x={textX} y={titleY}>{b.title}</text>
      <text className="s" x={textX} y={titleY + 17}>{b.sub}</text>
      {b.sub2 && <text className="s" x={textX} y={titleY + 34}>{b.sub2}</text>}
    </g>
  );
}

export function SystemDrawing() {
  return (
    <svg className="sys" viewBox="0 0 960 450" role="img" aria-label={LABEL}>
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: "var(--ink)", strokeWidth: 1 }} />
        </pattern>
        <marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path className="arrow" d="M0 0 L8 4 L0 8 z" />
        </marker>
      </defs>
      <text className="h" x="20" y="26">CHANNELS</text>
      <text className="h" x="320" y="26">AGENT</text>
      <text className="h" x="720" y="26">KNOWLEDGE AND CONNECTIONS</text>
      {BOXES.map(wireFor)}
      <Wire d="M322 240 V336 H115 V348" />
      <Wire d="M445 240 V348" />
      <text className="s" x="453" y="296">tool calls</text>
      <Wire d="M540 378 H718" />
      <text className="s" x="580" y="370">approved</text>
      <rect className="vm" x="330" y="322" width="230" height="104" />
      <text className="vmt" x="330" y="444">isolated microVM, one per thread</text>
      {BOXES.map((b) => <BoxShape key={b.title} b={b} />)}
    </svg>
  );
}
