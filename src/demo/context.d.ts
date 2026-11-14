declare module "virtual:bridlewise-public-replay" {
  const replay: import("./replay.ts").PublicReplay;
  export const workspaceHref: string;
  export const homeHref: string;
  export default replay;
}
