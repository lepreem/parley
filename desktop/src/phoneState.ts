/** What the phone access page shows. Shared by the main process and the page. */
export type PhoneState =
  | { status: "off" }
  | { status: "starting" }
  | { status: "missing" }
  | { status: "signedOut" }
  /** The tailnet hasn't allowed HTTPS yet; `url` is where its owner does. */
  | { status: "needsHttps"; url: string }
  | {
      status: "on";
      url: string;
      /** The only Tailscale account that gets in. */
      login: string;
      /** The QR code for `url`: an SVG path on a `size` by `size` grid. */
      qr: { size: number; path: string };
    }
  | { status: "failed"; output: string };

/** All the chat page is told, for the sidebar's label. */
export type PhoneSummary = "off" | "on" | "attention";

export function phoneSummary({ status }: PhoneState): PhoneSummary {
  if (status === "on") return "on";
  return status === "off" || status === "starting" ? "off" : "attention";
}
