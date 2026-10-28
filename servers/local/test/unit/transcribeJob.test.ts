import { beforeEach, describe, expect, it, vi } from "vitest";

const audioUploadId = "550e8400-e29b-41d4-a716-446655440000";
const claimToken = "7d0f1a52-5c4b-4f4e-9d4a-2f1d5f9f3c11";

const mocks = vi.hoisted(() => ({
  claimAudioJob: vi.fn(),
  unclaimAndResetAudioJob: vi.fn(),
  failAudioJob: vi.fn(),
  saveCompletedTranscript: vi.fn(),
  transcribeAI: vi.fn(),
  filePath: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("../../core/data", () => ({
  data: {
    jobs: {
      claimAudioJob: mocks.claimAudioJob,
      unclaimAndResetAudioJob: mocks.unclaimAndResetAudioJob,
      failAudioJob: mocks.failAudioJob,
    },
    transcripts: { saveCompletedTranscript: mocks.saveCompletedTranscript },
  },
}));

vi.mock("../../core/ai/ai_transcribe_client", () => ({
  DEFAULT_TRANSCRIBE_MODEL: "small",
  transcribeAI: mocks.transcribeAI,
}));

vi.mock("../../core/files", () => ({ files: { path: mocks.filePath } }));

vi.mock("../../core/message-queue/messageQueue", async (importActual) => ({
  ...(await importActual<
    typeof import("../../core/message-queue/messageQueue")
  >()),
  mq: {
    queues: { TRANSCRIBE_DONE: "transcribe_done" },
    publish: mocks.publish,
  },
}));

import { handleTranscribeJob } from "../../api/src/transcribeJob";
import { DeadLetterError } from "../../core/message-queue/messageQueue";

const audioInput = { audioUploadId } as const;
const firstAttempt = { attempt: 1, lastAttempt: false };
const lastAttempt = { attempt: 2, lastAttempt: true };

describe("handleTranscribeJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimAudioJob.mockResolvedValue({
      audioUploadId,
      transcriptModelId: null,
      claimToken,
    });
    mocks.filePath.mockReturnValue("/data/audios/audio-file");
    mocks.transcribeAI.mockRejectedValue(new Error("Whisper failed"));
    mocks.unclaimAndResetAudioJob.mockResolvedValue(true);
    mocks.failAudioJob.mockResolvedValue(undefined);
  });

  describe("storing a transcript", () => {
    const transcribed = [{ start: 0, end: 2, text: "the audio, transcribed" }];
    const captions = [{ start: 0, end: 2, text: "the captions" }];

    beforeEach(() => {
      mocks.transcribeAI.mockResolvedValue(transcribed);
      mocks.saveCompletedTranscript.mockResolvedValue(true);
      mocks.publish.mockResolvedValue(undefined);
    });

    it("stores the captions the message carries, without transcribing audio", async () => {
      await handleTranscribeJob(
        { audioUploadId, segments: captions },
        firstAttempt,
      );

      expect(mocks.filePath).not.toHaveBeenCalled();
      expect(mocks.transcribeAI).not.toHaveBeenCalled();
      expect(mocks.saveCompletedTranscript).toHaveBeenCalledWith(
        audioUploadId,
        captions,
        claimToken,
      );
    });

    it("transcribes the audio when the message carries no captions", async () => {
      await handleTranscribeJob(audioInput, firstAttempt);

      expect(mocks.filePath).toHaveBeenCalledWith({
        kind: "audio",
        uploadId: audioUploadId,
      });
      expect(mocks.transcribeAI).toHaveBeenCalledWith(
        "small",
        "/data/audios/audio-file",
      );
      expect(mocks.saveCompletedTranscript).toHaveBeenCalledWith(
        audioUploadId,
        transcribed,
        claimToken,
      );
    });

    it("announces the finished job to the API", async () => {
      await handleTranscribeJob(audioInput, firstAttempt);

      expect(mocks.publish).toHaveBeenCalledWith("transcribe_done", {
        audioUploadId,
      });
    });

    it("does nothing when there is no queued job to claim", async () => {
      mocks.claimAudioJob.mockResolvedValue(null);

      await handleTranscribeJob(audioInput, firstAttempt);

      expect(mocks.transcribeAI).not.toHaveBeenCalled();
      expect(mocks.saveCompletedTranscript).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    });

    it("announces nothing after losing its claim to a later attempt", async () => {
      mocks.saveCompletedTranscript.mockResolvedValue(false);

      await handleTranscribeJob(audioInput, firstAttempt);

      expect(mocks.publish).not.toHaveBeenCalled();
    });
  });

  describe("before the last attempt", () => {
    it("treats an empty transcript as a failure", async () => {
      mocks.transcribeAI.mockResolvedValue([{ start: 0, end: 1, text: "   " }]);

      await expect(
        handleTranscribeJob(audioInput, firstAttempt),
      ).rejects.toThrow("No speech found in the audio");

      expect(mocks.saveCompletedTranscript).not.toHaveBeenCalled();
      expect(mocks.unclaimAndResetAudioJob).toHaveBeenCalled();
    });

    it("unclaims and resets the job and rethrows, so the next attempt can claim it", async () => {
      await expect(
        handleTranscribeJob(audioInput, firstAttempt),
      ).rejects.toThrow("Whisper failed");

      expect(mocks.unclaimAndResetAudioJob).toHaveBeenCalledWith(
        audioUploadId,
        claimToken,
      );
      expect(mocks.failAudioJob).not.toHaveBeenCalled();
    });

    it("dead-letters the message when the unclaim and reset fails too", async () => {
      const unclaimError = new Error("database unavailable");
      mocks.unclaimAndResetAudioJob.mockRejectedValue(unclaimError);

      const failure = await handleTranscribeJob(audioInput, firstAttempt).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(DeadLetterError);
      expect((failure as DeadLetterError).cause).toBe(unclaimError);
      expect(mocks.failAudioJob).not.toHaveBeenCalled();
    });

    it("finishes the message when the job is no longer this worker's", async () => {
      mocks.unclaimAndResetAudioJob.mockResolvedValue(false);

      await expect(
        handleTranscribeJob(audioInput, firstAttempt),
      ).resolves.toBeUndefined();
    });

    it("leaves a failed claim to the consumer, touching no job", async () => {
      mocks.claimAudioJob.mockRejectedValue(new Error("database unavailable"));

      await expect(
        handleTranscribeJob(audioInput, firstAttempt),
      ).rejects.toThrow("database unavailable");

      expect(mocks.unclaimAndResetAudioJob).not.toHaveBeenCalled();
      expect(mocks.failAudioJob).not.toHaveBeenCalled();
    });
  });

  describe("on the last attempt", () => {
    it("fails the job for good and finishes the message", async () => {
      await expect(
        handleTranscribeJob(audioInput, lastAttempt),
      ).resolves.toBeUndefined();

      expect(mocks.unclaimAndResetAudioJob).not.toHaveBeenCalled();
    });

    // The reason is shown next to the file's name, so it can't be the raw
    // error ("Whisper failed").
    it("records a general reason for the user", async () => {
      await handleTranscribeJob(audioInput, lastAttempt);

      expect(mocks.failAudioJob).toHaveBeenCalledWith(
        audioUploadId,
        claimToken,
        "Could not be transcribed",
      );
    });

    it("says so when the audio had no speech in it", async () => {
      mocks.transcribeAI.mockResolvedValue([{ start: 0, end: 1, text: "   " }]);

      await handleTranscribeJob(audioInput, lastAttempt);

      expect(mocks.failAudioJob).toHaveBeenCalledWith(
        audioUploadId,
        claimToken,
        "No speech found in the audio",
      );
    });

    it("leaves the message to be dead-lettered when failing the job fails", async () => {
      mocks.failAudioJob.mockRejectedValue(new Error("database unavailable"));

      await expect(
        handleTranscribeJob(audioInput, lastAttempt),
      ).rejects.toThrow("database unavailable");
    });
  });
});
