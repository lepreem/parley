import type { ExistingSource } from "./context";

/**
 * A finished source dragged out of the library. Its own type, so the chat can
 * tell it from a file off the desktop while the drag is still in the air —
 * browsers only hand over the data itself on drop.
 */
const SOURCE_DRAG_TYPE = "application/x-parley-source";

export function startSourceDrag(
  dataTransfer: DataTransfer,
  source: ExistingSource,
) {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(SOURCE_DRAG_TYPE, JSON.stringify(source));
}

export function isSourceDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(SOURCE_DRAG_TYPE);
}

export function readSourceDrag(
  dataTransfer: DataTransfer,
): ExistingSource | null {
  const raw = dataTransfer.getData(SOURCE_DRAG_TYPE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ExistingSource;
  } catch {
    return null;
  }
}
