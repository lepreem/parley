import { describe, expect, it } from "vitest";
import { speechOnly } from "../../core/ai/speechOnly";

/** 16kHz 16-bit PCM, `ms` long, every sample `value`. */
const pcmOf = (ms: number, value: number) => {
  const pcm = Buffer.alloc((ms / 1000) * 16_000 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  return pcm;
};

const msOf = (pcm: Buffer) => (pcm.length / 2 / 16_000) * 1000;

describe("speechOnly", () => {
  it("keeps only the spans, with a short silence between", () => {
    const pcm = Buffer.concat([
      pcmOf(1000, 0),
      pcmOf(500, 7),
      pcmOf(2000, 0),
      pcmOf(300, 9),
    ]);

    const speech = speechOnly(pcm, [
      { startMs: 1000, endMs: 1500 },
      { startMs: 3500, endMs: 3800 },
    ]);

    expect(msOf(speech.pcm)).toBe(500 + 100 + 300);
    expect(speech.pcm.readInt16LE(0)).toBe(7);
    expect(speech.pcm.readInt16LE(speech.pcm.length - 2)).toBe(9);
    // The gap is silence.
    expect(speech.pcm.readInt16LE(((550 * 16_000) / 1000) * 2)).toBe(0);
  });

  it("maps a time in the speech back to the original", () => {
    const speech = speechOnly(pcmOf(10_000, 1), [
      { startMs: 1000, endMs: 1500 },
      { startMs: 3500, endMs: 3800 },
    ]);

    expect(speech.toOriginalMs(0)).toBe(1000);
    expect(speech.toOriginalMs(250)).toBe(1250);
    expect(speech.toOriginalMs(600)).toBe(3500);
    expect(speech.toOriginalMs(700)).toBe(3600);
    expect(speech.toOriginalMs(900)).toBe(3800);
  });

  it("maps a time in a gap to the end of the speech before it", () => {
    const speech = speechOnly(pcmOf(10_000, 1), [
      { startMs: 1000, endMs: 1500 },
      { startMs: 3500, endMs: 3800 },
    ]);

    expect(speech.toOriginalMs(550)).toBe(1500);
  });

  it("joins spans that overlap, so no audio plays twice", () => {
    const speech = speechOnly(pcmOf(10_000, 1), [
      { startMs: 2000, endMs: 3000 },
      { startMs: 1000, endMs: 2500 },
    ]);

    expect(msOf(speech.pcm)).toBe(2000);
    expect(speech.toOriginalMs(1500)).toBe(2500);
  });
});
