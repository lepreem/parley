/** What the setup page shows. Shared by the main process and the page. */
export type SetupState =
  | { screen: "starting"; detail?: string }
  | { screen: "missing" }
  | { screen: "signedOut" }
  | { screen: "working"; title: string; lines: string[] }
  | { screen: "error"; title: string; output: string; logPath: string };
