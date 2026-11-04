const ALWAYS_ALLOWED = ["clipboard-sanitized-write", "fullscreen"];

/**
 * Whether a page in the window gets what it asked for. Dictating needs the
 * microphone, so the chat page may have that. Nothing the app does needs the
 * camera, location or the like.
 */
export function isPermitted(
  permission: string,
  request: { requestingUrl: string; mediaTypes?: string[] | undefined },
  serverUrl: string | undefined,
): boolean {
  if (ALWAYS_ALLOWED.includes(permission)) return true;
  if (permission !== "media" || !serverUrl) return false;
  const { requestingUrl, mediaTypes = [] } = request;
  return (
    requestingUrl.startsWith(`${serverUrl}/`) &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === "audio")
  );
}
