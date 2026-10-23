import { describe, it, expect } from "vitest";
import { createApp } from "../../src/app";
import { QUEUES } from "../../src/message-queue/queues";
import { AUDIO_BUCKET, MAX_AUDIO_BYTES } from "../../src/storage";

describe("GET /contract", () => {
  it("serves the non-sensitive contract the youtube-fetcher reads at boot", async () => {
    const res = await (await createApp()).request("http://localhost/contract");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      queues: QUEUES,
      bucket: AUDIO_BUCKET,
      maxAudioBytes: MAX_AUDIO_BYTES,
    });
  });

  it("includes the cross-service queues + bucket the fetcher depends on", async () => {
    const res = await (await createApp()).request("http://localhost/contract");
    const body = (await res.json()) as {
      queues: Record<string, string>;
      bucket: string;
      maxAudioBytes: number;
    };
    // These keys + values are the contract contract.py consumes.
    expect(body.queues.FETCH_YOUTUBE_CAPTIONS).toBe("fetch_youtube_captions");
    expect(body.queues.FETCH_YOUTUBE_AUDIO).toBe("fetch_youtube_audio");
    expect(body.queues.SAVE_CAPTIONS).toBe("save_captions");
    expect(body.queues.TRANSCRIBE_AUDIO).toBe("transcribe_audio");
    expect(body.queues.FAIL_YOUTUBE_JOB).toBe("fail_youtube_job");
    expect(body.bucket).toBe("Audio");
    expect(body.maxAudioBytes).toBe(50 * 1024 * 1024);
  });
});
