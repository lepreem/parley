/**
 * A YouTube video's captions: `youtubeCaptions.<what>`. Supadata fetches them
 * (supadata.ts); outside this folder nothing knows that, so another service
 * replaces that one file.
 */

export { ping, fetchCaptions } from "./supadata";
export { CAPTIONS_MESSAGES, CaptionsError } from "./errors";
