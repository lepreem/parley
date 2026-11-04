import { describe, expect, it } from "vitest";
import { isPermitted } from "../src/permissions";

const SERVER = "http://127.0.0.1:47821";
const chatPage = { requestingUrl: `${SERVER}/` };

describe("isPermitted", () => {
  it("gives the chat page the microphone", () => {
    expect(
      isPermitted("media", { ...chatPage, mediaTypes: ["audio"] }, SERVER),
    ).toBe(true);
  });

  it.each([[["video"]], [["audio", "video"]], [[]], [undefined]])(
    "refuses media types %j",
    (mediaTypes) => {
      expect(isPermitted("media", { ...chatPage, mediaTypes }, SERVER)).toBe(
        false,
      );
    },
  );

  it.each([
    ["the setup page", "file:///app/static/setup.html"],
    ["another site", "https://example.com/"],
    ["a port that only starts the same", `${SERVER}9/`],
  ])("refuses the microphone to %s", (_name, requestingUrl) => {
    expect(
      isPermitted("media", { requestingUrl, mediaTypes: ["audio"] }, SERVER),
    ).toBe(false);
  });

  it("refuses the microphone before the server is up", () => {
    expect(
      isPermitted("media", { ...chatPage, mediaTypes: ["audio"] }, undefined),
    ).toBe(false);
  });

  it("still allows the clipboard and fullscreen, and nothing else", () => {
    expect(isPermitted("fullscreen", chatPage, SERVER)).toBe(true);
    expect(isPermitted("clipboard-sanitized-write", chatPage, SERVER)).toBe(
      true,
    );
    expect(isPermitted("geolocation", chatPage, SERVER)).toBe(false);
  });
});
