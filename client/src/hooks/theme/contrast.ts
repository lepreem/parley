/**
 * WCAG contrast between two oklch() colours, for themes.test.ts. Out-of-gamut
 * channels clip the way a browser would show them.
 */

type Oklch = { l: number; c: number; h: number };

/** `oklch(L C H)` with plain numbers, as themes.css writes them. */
export function parseOklch(value: string): Oklch | null {
  const match = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!match) return null;
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

/** Relative luminance, from oklch through linear sRGB. */
function luminance({ l, c, h }: Oklch): number {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ];
  const [red, green, blue] = [
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.707614701],
  ].map((row) =>
    Math.min(
      1,
      Math.max(0, row[0] * lms[0] + row[1] * lms[1] + row[2] * lms[2]),
    ),
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrast(first: Oklch, second: Oklch): number {
  const [light, dark] = [luminance(first), luminance(second)].sort(
    (x, y) => y - x,
  );
  return (light + 0.05) / (dark + 0.05);
}
