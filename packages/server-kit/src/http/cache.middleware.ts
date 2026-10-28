import { etag } from "hono/etag";
import { createMiddleware } from "hono/factory";

type HttpCachePolicy =
  | {
      maxAgeSeconds: number;
      staleWhileRevalidateSeconds?: number;
    }
  | { revalidate: true };

function formatCacheControl(policy: HttpCachePolicy) {
  if ("revalidate" in policy) return "private, no-cache";

  const directives = ["private", `max-age=${policy.maxAgeSeconds}`];
  if (policy.staleWhileRevalidateSeconds !== undefined) {
    directives.push(
      `stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`,
    );
  }
  return directives.join(", ");
}

export function httpCache(policy: HttpCachePolicy) {
  const applyEtag = etag();
  const cacheControl = formatCacheControl(policy);

  return createMiddleware(async (context, next) => {
    await applyEtag(context, next); // Let ETag finalize 200/304 before adding Cache-Control.

    const cacheable = context.res.status === 200 || context.res.status === 304;
    if (cacheable) context.res.headers.set("Cache-Control", cacheControl);
  });
}
