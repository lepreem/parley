import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createEventHub } from "@parley/server-kit/sse/hub";

const hub = createEventHub<string>();
const app = new Hono();
app.get("/events/:group", (c) => hub.stream(c, c.req.param("group")));

/** Opens a group's stream and reads it chunk by chunk, as text. */
async function open(group: string) {
  const res = await app.request(`http://localhost/events/${group}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  return {
    res,
    async next() {
      const { value, done } = await reader.read();
      return done ? null : decoder.decode(value);
    },
  };
}

afterEach(async () => {
  await hub.close();
});

describe("createEventHub", () => {
  it("answers with an event stream that starts with a heartbeat", async () => {
    const stream = await open("u1");

    expect(stream.res.headers.get("Content-Type")).toContain(
      "text/event-stream",
    );
    expect(await stream.next()).toBe(": heartbeat\n\n");
  });

  it("pushes an event to every stream in its group", async () => {
    const first = await open("u1");
    const second = await open("u1");
    await first.next();
    await second.next();

    hub.send("u1", "jobUpdated", { audioUploadId: "a1" });

    const expected = 'event: jobUpdated\ndata: {"audioUploadId":"a1"}\n\n';
    expect(await first.next()).toBe(expected);
    expect(await second.next()).toBe(expected);
  });

  it("keeps an event out of other groups' streams", async () => {
    const other = await open("u2");
    await other.next();

    hub.send("u1", "jobUpdated", { audioUploadId: "a1" });
    hub.send("u2", "jobUpdated", { audioUploadId: "a2" });

    expect(await other.next()).toContain('"audioUploadId":"a2"');
  });

  it("ends every open stream when it closes", async () => {
    const stream = await open("u1");
    await stream.next();

    await hub.close();

    expect(await stream.next()).toBeNull();
  });
});
