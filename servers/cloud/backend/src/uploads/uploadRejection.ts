import type { uploads } from "./uploads";

type Rejection = Extract<
  Awaited<ReturnType<typeof uploads.check>>,
  { ok: false }
>;

/** The two wordings that differ per kind; the rest read the same either way. */
type Wording = {
  /** Names the upload in "No uploaded <noun> to confirm". */
  noun: string;
  wrongType: (contentType: string) => string;
  tooLarge: string;
};

/**
 * A confirm handler's response to an upload that can't be confirmed. Shared so
 * the audio and image endpoints answer the same refusal the same way.
 */
export const ALREADY_CONFIRMED = "This upload was already confirmed";

export function uploadRejection(rejection: Rejection, wording: Wording) {
  switch (rejection.reason) {
    case "missing":
      return [
        { message: `No uploaded ${wording.noun} to confirm` },
        404,
      ] as const;
    case "already-confirmed":
      return [{ message: ALREADY_CONFIRMED }, 409] as const;
    case "expired":
      return [
        { message: "This upload has expired; upload the file again" },
        410,
      ] as const;
    case "wrong-type":
      return [
        { message: wording.wrongType(rejection.contentType) },
        400,
      ] as const;
    case "too-large":
      return [
        { message: wording.tooLarge, maxBytes: rejection.maxBytes },
        413,
      ] as const;
  }
}
