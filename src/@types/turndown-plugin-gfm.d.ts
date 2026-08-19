declare module "turndown-plugin-gfm" {
  import TurndownService from "turndown";
  export function gfm(turndown: TurndownService): void;
  export const tables: (turndown: TurndownService) => void;
  export const strikethrough: (turndown: TurndownService) => void;
  export const taskListItems: (turndown: TurndownService) => void;
}