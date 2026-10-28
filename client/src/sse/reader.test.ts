import { describe, expect, it } from "vitest";
import { readServerSentEvents, type ServerSentEvent } from "./reader";

/** A body that arrives in exactly these chunks. */
function body(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function read(stream: ReadableStream<Uint8Array>) {
  const events: ServerSentEvent[] = [];
  await readServerSentEvents(stream, (event) => events.push(event));
  return events;
}

describe("readServerSentEvents", () => {
  it("reads named events and their data", async () => {
    expect(
      await read(
        body('event: delta\ndata: {"delta":"Hi"}\n\nevent: done\ndata: {}\n\n'),
      ),
    ).toEqual([
      { event: "delta", data: '{"delta":"Hi"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("puts an event split across chunks back together", async () => {
    expect(
      await read(body("event: del", 'ta\ndata: {"de', 'lta":"Hi"}\n', "\n")),
    ).toEqual([{ event: "delta", data: '{"delta":"Hi"}' }]);
  });

  it("skips comments, such as a heartbeat", async () => {
    expect(await read(body(": heartbeat\n\nevent: x\ndata: 1\n\n"))).toEqual([
      { event: "x", data: "1" },
    ]);
  });

  it("names an event message when the server doesn't", async () => {
    expect(await read(body("data: 1\n\n"))).toEqual([
      { event: "message", data: "1" },
    ]);
  });

  it("reads CRLF line endings and a last event without its blank line", async () => {
    expect(
      await read(body("event: x\r\ndata: 1\r\n\r\nevent: y\ndata: 2")),
    ).toEqual([
      { event: "x", data: "1" },
      { event: "y", data: "2" },
    ]);
  });
});
