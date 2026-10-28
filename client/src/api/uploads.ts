import type {
  QueuedYoutube,
  QueueYoutubeBody,
  UploadedAudio,
  UploadedImage,
} from "@parley/contract";
import { ApiError, apiJson, jsonRequest } from "./http";
import { serverUrl, type Server } from "./server";

export type { UploadedImage };

/**
 * Wire names for the request fields, mirroring the field names the servers'
 * upload schemas read (servers/cloud/backend/src/schema/upload.schema.ts,
 * and FORM_KEYS in servers/local/shared/keys.ts). A field the server doesn't
 * recognise is silently dropped by its validator, so these have to match exactly.
 */
const FORM_KEYS = {
  uploadId: "uploadId",
  fileName: "fileName",
  file: "file",
  audioSource: "audioSource",
  transcriptModelId: "transcriptModelId",
} as const;

/** A multipart request carrying `file` and the other fields given. */
function directUpload(file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append(FORM_KEYS.file, file);
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return { method: "POST", body: form };
}

type UploadTarget = { uploadId: string; signedUploadUrl: string };

/**
 * Sends a file straight to storage: the API mints a URL bound to one storage
 * key, and the bytes go there without passing through the API.
 */
async function uploadToStorage(
  server: Server,
  mintPath: string,
  file: File,
): Promise<string> {
  const { uploadId, signedUploadUrl } = await apiJson<UploadTarget>(
    server,
    mintPath,
    jsonRequest("POST", {}),
  );

  // Not apiFetch: storage is another origin and answers CORS with a wildcard,
  // which browsers refuse for credentialed requests. The URL's token is the
  // only authorization this request needs.
  const response = await fetch(signedUploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!response.ok) {
    throw new ApiError(
      "Could not upload the file. Please try again.",
      response.status,
      null,
    );
  }

  return uploadId;
}

/** Stored immediately on drop; its url is what previews the image. */
export async function uploadImage(
  server: Server,
  file: File,
): Promise<UploadedImage> {
  let uploaded: UploadedImage;
  if (server.uploads === "direct") {
    uploaded = await apiJson<UploadedImage>(
      server,
      "/upload/image",
      directUpload(file),
    );
  } else {
    const uploadId = await uploadToStorage(server, "/upload/image", file);
    uploaded = await apiJson<UploadedImage>(
      server,
      "/upload/image/confirm",
      jsonRequest("POST", {
        [FORM_KEYS.uploadId]: uploadId,
        [FORM_KEYS.fileName]: file.name,
      }),
    );
  }
  return { ...uploaded, url: serverUrl(server, uploaded.url) };
}

/** Deletes a resolved image removed from a draft. */
export async function deleteImage(
  server: Server,
  imageUploadId: string,
): Promise<void> {
  await apiJson<{ message: string }>(server, `/upload/image/${imageUploadId}`, {
    method: "DELETE",
  });
}

/**
 * Speech audio — already extracted from video and compressed by the caller.
 * `source` records what it came from; the transcribe job is queued server-side
 * once the upload is confirmed.
 */
export async function uploadAudio(
  server: Server,
  upload: {
    file: File;
    source: "audio" | "video";
    transcriptModelId: string;
  },
): Promise<UploadedAudio> {
  if (server.uploads === "direct") {
    return apiJson<UploadedAudio>(
      server,
      "/upload/audio",
      directUpload(upload.file, {
        [FORM_KEYS.audioSource]: upload.source,
        [FORM_KEYS.transcriptModelId]: upload.transcriptModelId,
      }),
    );
  }

  const uploadId = await uploadToStorage(server, "/upload/audio", upload.file);

  return apiJson<UploadedAudio>(
    server,
    "/upload/audio/confirm",
    jsonRequest("POST", {
      [FORM_KEYS.uploadId]: uploadId,
      [FORM_KEYS.fileName]: upload.file.name,
      [FORM_KEYS.audioSource]: upload.source,
      [FORM_KEYS.transcriptModelId]: upload.transcriptModelId,
    }),
  );
}

/** The audio is fetched and transcribed server-side — nothing leaves this device. */
export async function requestYoutubeTranscript(
  server: Server,
  youtubeUrl: string,
  transcriptModelId: string,
): Promise<QueuedYoutube> {
  return apiJson<QueuedYoutube>(
    server,
    "/upload/youtube",
    jsonRequest("POST", {
      youtubeUrl,
      [FORM_KEYS.transcriptModelId]: transcriptModelId,
    } satisfies QueueYoutubeBody),
  );
}
