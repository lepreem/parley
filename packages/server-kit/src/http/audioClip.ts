import { MAX_DICTATION_BYTES } from "@parley/contract/limits";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";

/** Turns away a recording over the limit, before reading any more of it. */
export const audioClipLimit = bodyLimit({
  maxSize: MAX_DICTATION_BYTES,
  onError: (c) => c.json({ message: "That recording is too long" }, 413),
});

/**
 * A short recording sent as the request's whole body, read into memory and
 * never stored. audioClipLimit goes ahead of this.
 */
export const audioClipBody = createMiddleware<{
  Variables: { audioClip: Uint8Array<ArrayBuffer> };
}>(async (c, next) => {
  if (!c.req.header("Content-Type")?.startsWith("audio/")) {
    return c.json({ message: "Expected audio" }, 415);
  }
  const clip = new Uint8Array(await c.req.arrayBuffer());
  if (clip.length === 0) {
    return c.json({ message: "The recording is empty" }, 400);
  }
  c.set("audioClip", clip);
  await next();
});
