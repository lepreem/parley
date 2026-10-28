import { getApiEnv } from "../../core/env";

/** This machine's names, as a URL's hostname spells them. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a hostname is one the app answers to: this machine's, or one
 * listed in ALLOWED_HOSTS, like the Tailscale name a phone reaches it by.
 */
export function isAllowedHostname(hostname: string): boolean {
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    getApiEnv().ALLOWED_HOSTS.includes(hostname)
  );
}

/**
 * Whether an Origin header is a page the app trusts: one served under an
 * allowed name, or one listed in ALLOWED_ORIGINS, like the hosted client. A
 * page from this machine comes from a process here, which could reach the API
 * directly anyway, and a listed name or origin is one the user chose; any
 * other origin is a site the browser happens to have open.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (getApiEnv().ALLOWED_ORIGINS.includes(origin.toLowerCase())) return true;
  try {
    return isAllowedHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
