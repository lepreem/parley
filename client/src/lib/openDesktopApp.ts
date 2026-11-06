/** The link the desktop app registers itself for. */
export const DESKTOP_APP_LINK = "parley://open";

/** Long enough for the browser to hand over, or ask whether it may. */
const HANDOVER_MS = 1_500;

/**
 * Tries to open the desktop app, calling `notInstalled` if it seems not to be.
 * A browser won't say whether a link's app exists, only that the page lost
 * focus to it or to the question of whether to open it. A wrong guess lands on
 * the download page, which offers the same link again.
 */
export function openDesktopApp(notInstalled: () => void) {
  let handedOver = false;
  const onBlur = () => {
    handedOver = true;
  };
  window.addEventListener("blur", onBlur);
  window.location.href = DESKTOP_APP_LINK;
  window.setTimeout(() => {
    window.removeEventListener("blur", onBlur);
    if (!handedOver && !document.hidden) notInstalled();
  }, HANDOVER_MS);
}
