// Files imported with `with { type: "file" }` resolve to a path (embedded in the compiled executable).
declare module "*.min.js" {
  const path: string;
  export default path;
}
