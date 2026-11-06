import type { PhoneState } from "./phoneState";
import {
  enableHttpsUrl,
  isServing,
  type Serve,
  type TailscaleStatus,
} from "./tailscale";

/**
 * How often it looks again while on, which is what picks up Tailscale being
 * installed, signed in to or restarted, with nothing for the person to press.
 */
const CHECK_INTERVAL_MS = 10_000;

export type PhoneAccessDeps = {
  loadEnabled(): boolean;
  saveEnabled(enabled: boolean): void;
  readTailscale(): Promise<TailscaleStatus>;
  startServe(
    program: string,
    port: number,
    onOutput: (output: string) => void,
    onExit: (code: number | null, output: string) => void,
  ): Serve;
  /** Tells the server which name and account to answer, or none. */
  allow(access: { hostname: string; login: string } | undefined): void;
  qrFor(url: string): { size: number; path: string };
  onChange(state: PhoneState): void;
};

type Serving = Serve & {
  program: string;
  port: number;
  hostname: string;
  login: string;
};

/**
 * Keeps this machine reachable from the person's phone while they want it to
 * be. Each check compares what should be running with what is and fixes the
 * difference, so a server restart, a Tailscale restart and a change of account
 * all take the same path.
 */
export class PhoneAccess {
  private enabled: boolean;
  private port: number | undefined;
  private serving: Serving | undefined;
  private state: PhoneState = { status: "off" };
  private timer: NodeJS.Timeout | undefined;
  private checking = false;
  private checkAgain = false;

  constructor(private readonly deps: PhoneAccessDeps) {
    this.enabled = deps.loadEnabled();
    if (this.enabled) this.state = { status: "starting" };
  }

  getState(): PhoneState {
    return this.state;
  }

  /** The server's port once it's up, or undefined when it has gone. */
  serverChanged(port: number | undefined): void {
    this.port = port;
    // Its replacement knows nothing of what this one was told.
    this.stopServing();
    if (!this.enabled) return;
    this.setState({ status: "starting" });
    void this.startChecking();
  }

  async enable(): Promise<void> {
    this.enabled = true;
    this.deps.saveEnabled(true);
    this.setState({ status: "starting" });
    await this.startChecking();
  }

  disable(): void {
    this.enabled = false;
    this.deps.saveEnabled(false);
    this.stopChecking();
    this.stopServing();
    this.deps.allow(undefined);
    this.setState({ status: "off" });
  }

  /** Stops serving as the app quits; the setting stays for the next launch. */
  shutdown(): void {
    this.stopChecking();
    this.stopServing();
  }

  /** Looks now rather than at the next interval. */
  async check(): Promise<void> {
    if (this.checking) {
      this.checkAgain = true;
      return;
    }
    this.checking = true;
    try {
      do {
        this.checkAgain = false;
        await this.reconcile();
      } while (this.checkAgain);
    } finally {
      this.checking = false;
    }
  }

  private async startChecking(): Promise<void> {
    this.timer ??= setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    await this.check();
  }

  private stopChecking() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async reconcile() {
    if (!this.enabled || this.port === undefined) return;
    const tailscale = await this.deps.readTailscale();
    // It may have been turned off, or the server gone, while that ran.
    const port = this.port;
    if (!this.enabled || port === undefined) return;

    if (tailscale.state !== "ready") {
      this.stopServing();
      this.deps.allow(undefined);
      this.setState(
        tailscale.state === "tagged"
          ? {
              status: "failed",
              output:
                "This computer is a tagged device in Tailscale, so Tailscale can't say whose phone is asking. Use a computer signed in to your own account.",
            }
          : { status: tailscale.state },
      );
      return;
    }

    const { program, hostname, login } = tailscale;
    const current = this.serving;
    if (
      current?.program === program &&
      current.port === port &&
      current.hostname === hostname &&
      current.login === login
    ) {
      return;
    }

    this.stopServing();
    // Before serving, so the name is never reachable with the wrong account.
    this.deps.allow({ hostname, login });
    const url = `https://${hostname}/`;
    const serving: Serving = {
      program,
      port,
      hostname,
      login,
      ...this.deps.startServe(
        program,
        port,
        (output) => {
          if (this.serving !== serving) return;
          if (isServing(output)) {
            this.setState({
              status: "on",
              url,
              login,
              qr: this.deps.qrFor(url),
            });
            return;
          }
          const enableUrl = enableHttpsUrl(output);
          if (enableUrl)
            this.setState({ status: "needsHttps", url: enableUrl });
        },
        (code, output) => {
          if (this.serving !== serving) return;
          this.serving = undefined;
          // Told where to allow HTTPS and left; the next check runs it again.
          if (code === 0 && enableHttpsUrl(output)) return;
          this.deps.allow(undefined);
          this.setState({ status: "failed", output });
        },
      ),
    };
    this.serving = serving;
  }

  private stopServing() {
    const serving = this.serving;
    this.serving = undefined;
    serving?.stop();
  }

  private setState(state: PhoneState) {
    this.state = state;
    this.deps.onChange(state);
  }
}
