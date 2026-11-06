import qrcode from "qrcode-generator";

/**
 * A QR code as one SVG path, on a grid `size` squares wide. The page draws it,
 * since its security policy allows no inline images.
 */
export function qrFor(text: string): { size: number; path: string } {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  let path = "";
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (code.isDark(row, column)) path += `M${column} ${row}h1v1h-1z`;
    }
  }
  return { size, path };
}
