/** One server-sent event, as it came off the wire. */
export type ServerSentEvent = { event: string; data: string };

/**
 * Reads server-sent events off a response body, handing each to `onEvent`,
 * until the body ends. Comment lines (a heartbeat, say) and events without
 * data are skipped. Rejects if the body does, as when its request is
 * aborted, or if `onEvent` throws.
 *
 * fetch rather than EventSource: EventSource can't POST, as a chat reply
 * needs, and gives up for good on an HTTP error, where a session that
 * expired should be refreshed and the stream opened again.
 */
export async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (raw: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:"))
        dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) onEvent({ event, data: dataLines.join("\n") });
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const raw of events) dispatch(raw);
    if (done) break;
  }
  if (buffer.trim()) dispatch(buffer);
}
