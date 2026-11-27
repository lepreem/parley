/// <reference types="node" />
// Read from disk: Vitest stubs CSS imports out, even with ?raw.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, parseOklch } from "./contrast";
import { THEMES } from "./themes";

const stylesheet = (name: string) =>
  readFileSync(new URL(`../../${name}`, import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

/** Every `selector { body }` block in a stylesheet. */
function blocks(source: string) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    tokens: [...match[2].matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).sort(),
    values: new Map(
      [...match[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
        m[1],
        m[2].trim(),
      ]),
    ),
  }));
}

// The tokens Tailwind's colours are built from: each palette must set them all.
const theme = stylesheet("index.css").match(
  /@theme inline \{([\s\S]*?)\n\}/,
)?.[1];
const expected = [...(theme ?? "").matchAll(/:\s*var\((--[\w-]+)\)/g)]
  .map((match) => match[1])
  .sort();
const palettes = blocks(stylesheet("themes.css"));

/**
 * Text and the surfaces it sits on, with the contrast each pair needs: 7:1
 * for body text, WCAG's 4.5:1 for other text, 3:1 for hints and the accent
 * as a focus ring or border.
 */
const FLOORS: [text: string, on: string, floor: number][] = [
  ["text", "canvas", 7],
  ["text", "surface", 7],
  ["text", "sunk", 7],
  ["text-muted", "canvas", 4.5],
  ["text-muted", "surface", 4.5],
  ["text-muted", "sunk", 4.5],
  ["text-faint", "surface", 3],
  ["signal-ink", "canvas", 4.5],
  ["signal-ink", "surface", 4.5],
  ["signal-ink", "signal-tint", 4.5],
  ["on-signal", "signal", 4.5],
  ["on-signal", "signal-strong", 4.5],
  ["on-live", "live", 4.5],
  ["live", "surface", 4.5],
  ["live", "live-tint", 4.5],
  ["signal", "canvas", 3],
];

/** The tokens a palette sets. Everything else is the shared neutrals. */
const ACCENT = [
  "--on-signal",
  "--signal",
  "--signal-ink",
  "--signal-strong",
  "--signal-tint",
];

const SELECTORS = {
  light: (match: string) => `[data-theme${match}]`,
  dark: (match: string) =>
    `.dark[data-theme${match}],\n.dark [data-theme${match}]`,
};

describe("themes.css", () => {
  it("finds the tokens", () => {
    expect(expected).toContain("--signal");
    for (const token of ACCENT) expect(expected).toContain(token);
  });

  for (const mode of ["light", "dark"] as const) {
    it(`sets every neutral token, and no accent, once for ${mode}`, () => {
      const base = palettes.find(
        (found) => found.selector === SELECTORS[mode](""),
      );
      expect(base?.tokens).toEqual(
        expected.filter((token) => !ACCENT.includes(token)),
      );
    });
  }

  for (const { id } of THEMES) {
    for (const mode of ["light", "dark"] as const) {
      it(`gives ${id} only the accent, readable, in ${mode}`, () => {
        const base = palettes.find(
          (found) => found.selector === SELECTORS[mode](""),
        );
        const block = palettes.find(
          (found) => found.selector === SELECTORS[mode](`="${id}"`),
        );
        expect(block?.tokens).toEqual(ACCENT);
        const values = new Map([
          ...(base?.values ?? []),
          ...(block?.values ?? []),
        ]);
        for (const [text, on, floor] of FLOORS) {
          const fg = parseOklch(values.get(text) ?? "");
          const bg = parseOklch(values.get(on) ?? "");
          expect(fg, `--${text} as oklch()`).not.toBeNull();
          expect(bg, `--${on} as oklch()`).not.toBeNull();
          if (!fg || !bg) continue;
          expect(
            contrast(fg, bg),
            `--${text} on --${on}`,
          ).toBeGreaterThanOrEqual(floor);
        }
      });
    }
  }

  it("has no palette the picker doesn't offer", () => {
    const ids = new Set<string>(THEMES.map(({ id }) => id));
    for (const { selector } of palettes) {
      for (const [, id] of selector.matchAll(/data-theme="([^"]+)"/g)) {
        expect(ids).toContain(id);
      }
    }
  });
});
