import { createServer } from "node:net";

/**
 * The port the app tries first. It stays the same between launches because the
 * page's saved settings belong to its address; high enough to be unlikely to
 * be taken.
 */
export const PREFERRED_PORT = 47821;

/** Listens on `port`, 0 for any free one, and gives back what it got. */
function tryPort(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(undefined));
    probe.listen(port, "127.0.0.1", () => {
      const address = probe.address();
      const got = typeof address === "object" ? address?.port : undefined;
      probe.close(() => resolve(got));
    });
  });
}

/** `preferred` if it's free, or else any port that is. */
export async function freePort(preferred = PREFERRED_PORT): Promise<number> {
  const port = (await tryPort(preferred)) ?? (await tryPort(0));
  if (port === undefined) throw new Error("No free port on 127.0.0.1");
  return port;
}
