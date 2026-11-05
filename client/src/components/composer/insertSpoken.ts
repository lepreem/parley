/**
 * `text` with `spoken` in place of what's selected, or at the caret, set off
 * by a space where it would otherwise run into a word. `caret` is where the
 * caret belongs after it.
 */
export function insertSpoken(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  spoken: string,
): { text: string; caret: number } {
  const before = text.slice(0, selectionStart);
  const after = text.slice(selectionEnd);
  const inserted =
    (before && !/\s$/.test(before) ? " " : "") +
    spoken +
    (after && !/^\s/.test(after) ? " " : "");
  return {
    text: before + inserted + after,
    caret: before.length + inserted.length,
  };
}
