// Bun text imports (`import x from "./f.md" with { type: "text" }`).
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.sql" {
  const text: string;
  export default text;
}
// Bun parses YAML imports (slack/manifest.yaml) into plain objects.
declare module "*.yaml" {
  const value: unknown;
  export default value;
}
// Bun file imports (`import path from "./x.wasm" with { type: "file" }`): a path that
// `bun build --compile` embeds in the binary.
declare module "*.wasm" {
  const path: string;
  export default path;
}
