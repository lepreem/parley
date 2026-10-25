import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/db", async () =>
  (await import("../helpers/inMemoryDb")).inMemoryDbModule(),
);

import { createApp } from "../../api/app";
import { EVERYONE, events } from "../../api/src/events";

describe("GET /events", () => {
  it("streams job updates to a page the app trusts", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/events", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);
    expect(await next()).toBe(": heartbeat\n\n");

    events.send(EVERYONE, "jobUpdated", { audioUploadId: "a1" });

    expect(await next()).toBe(
      'event: jobUpdated\ndata: {"audioUploadId":"a1"}\n\n',
    );
    await events.close();
  });
});
