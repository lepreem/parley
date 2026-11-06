import { z } from "zod";
import { getApiEnv } from "../../core/env";

/** This machine's names, as a URL's hostname spells them. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const phoneAccessSchema = z.object({
  hostname: z.string().min(1).nullable(),
  login: z.string().min(1).nullable(),
});

/** The desktop app's phone access, while it's on. */
let phoneAccess: { hostname: string; login: string } | undefined;

/**
 * Takes what the desktop app says about phone access. Only the process that
 * started this one can send it, and it can turn this on or off while chats and
 * transcriptions run, which restarting the server couldn't.
 */
export function receivePhoneAccess(message: unknown): void {
  const parsed = phoneAccessSchema.safeParse(message);
  if (!parsed.success) return;
  const { hostname, login } = parsed.data;
  phoneAccess = hostname && login ? { hostname, login } : undefined;
}

/**
 * Whether a hostname is one the app answers to: this machine's, or one
 * listed in ALLOWED_HOSTS, like the Tailscale name a phone reaches it by.
 */
function isAllowedHostname(hostname: string): boolean {
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    getApiEnv().ALLOWED_HOSTS.includes(hostname) ||
    phoneAccess?.hostname === hostname
  );
}

/**
 * Whether a request may be answered. Under the desktop app's phone access name
 * it must also come from the account that turned it on, since a tailnet can
 * hold other people's devices. Tailscale replaces whatever login the request
 * claims with the real one, and sends none for traffic from outside the tailnet.
 */
export function isAllowedRequest(
  hostname: string,
  tailscaleLogin: string | undefined,
): boolean {
  if (phoneAccess?.hostname === hostname) {
    return tailscaleLogin === phoneAccess.login;
  }
  return isAllowedHostname(hostname);
}

/**
 * Whether an Origin header is a page the app trusts: one served under an
 * allowed name. A page from this machine comes from a process here, which could
 * reach the API directly anyway, and a listed name is one the user chose; any
 * other origin is a site the browser happens to have open.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return isAllowedHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
