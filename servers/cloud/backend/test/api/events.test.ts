import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { eventHub } from "../../src/sse/hub";
import { sessionCookieHeader } from "../helpers/session";

/** Opens /events as `userId` and reads it chunk by chunk, as text. */
async function open(userId: string) {
  const res = await (
    await createApp()
  ).request("http://localhost/events", {
    headers: { Cookie: await sessionCookieHeader(userId) },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  return {
    res,
    next: async () => decoder.decode((await reader.read()).value),
  };
}

afterEach(async () => {
  await eventHub.close();
});

describe("GET /events", () => {
  it("returns 401 without a session cookie", async () => {
    const res = await (await createApp()).request("http://localhost/events");
    expect(res.status).toBe(401);
  });

  it("streams the signed-in user's job updates", async () => {
    const stream = await open("user_01");
    expect(stream.res.status).toBe(200);
    expect(await stream.next()).toBe(": heartbeat\n\n");

    eventHub.send("user_01", "jobUpdated", { audioUploadId: "a1" });

    expect(await stream.next()).toBe(
      'event: jobUpdated\ndata: {"audioUploadId":"a1"}\n\n',
    );
  });

  it("keeps another user's job updates out", async () => {
    const stream = await open("user_01");
    await stream.next();

    eventHub.send("user_02", "jobUpdated", { audioUploadId: "theirs" });
    eventHub.send("user_01", "jobUpdated", { audioUploadId: "mine" });

    expect(await stream.next()).toContain('"audioUploadId":"mine"');
  });
});
