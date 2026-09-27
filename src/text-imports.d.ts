// Bun text imports (`import x from "./f.md" with { type: "text" }`).
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.sql" {
  const text: string;
  export default text;
}
