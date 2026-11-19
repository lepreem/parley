import { useCallback, useState } from "react";
import {
  AVATAR_COLORS,
  AVATAR_GLYPHS,
  defaultAvatar,
  type Avatar as AvatarIds,
} from "@parley/contract/avatars";
import {
  useProfileQuery,
  useUpdateAvatarMutation,
} from "../../hooks/queries/useProfileQueries";
import { useDismissable } from "../ui/useDismissable";
import { Avatar } from "./Avatar";
import { COLOR_ART, COLOR_LABELS, GLYPH_LABELS } from "./avatarArt";

/**
 * The signed-in user's picture, which opens a picker above it: a glyph, and
 * the colour it sits on. Each pick saves at once; there's no Save button to
 * forget.
 */
export function AvatarButton({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const popoverRef = useDismissable<HTMLDivElement>(open, close);
  const profile = useProfileQuery(userId);
  const updateAvatar = useUpdateAvatarMutation(userId);

  // Until the server answers, the default it would answer with.
  const avatar = profile.data?.avatar ?? defaultAvatar(userId);
  const pick = (next: AvatarIds) => {
    if (next.glyph === avatar.glyph && next.color === avatar.color) return;
    updateAvatar.mutate(next);
  };

  return (
    <div ref={popoverRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-label="Change your picture"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="block rounded-full transition-transform hover:scale-105 motion-reduce:transition-none"
      >
        <Avatar avatar={avatar} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Your picture"
          className="absolute bottom-full left-0 z-50 mb-2 w-[15.5rem] rounded-xl border border-line bg-surface p-3 shadow-xl"
        >
          <div className="flex items-center gap-3 pb-3">
            <Avatar avatar={avatar} className="h-12 w-12" />
            <div>
              <p className="text-sm font-semibold text-ink">Your picture</p>
              <p className="text-xs text-faint">Pick a shape and a colour.</p>
            </div>
          </div>

          <p className="eyebrow pb-1.5 text-faint">Shape</p>
          <div
            role="radiogroup"
            aria-label="Shape"
            className="grid grid-cols-6 gap-1.5"
          >
            {AVATAR_GLYPHS.map((glyph) => {
              const chosen = glyph === avatar.glyph;
              return (
                <button
                  key={glyph}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  aria-label={GLYPH_LABELS[glyph]}
                  title={GLYPH_LABELS[glyph]}
                  onClick={() => pick({ glyph, color: avatar.color })}
                  className={`rounded-full p-0.5 ring-2 transition-shadow ${
                    chosen
                      ? "ring-signal"
                      : "ring-transparent hover:ring-line-strong"
                  }`}
                >
                  <Avatar
                    avatar={{ glyph, color: avatar.color }}
                    className="h-full w-full"
                  />
                </button>
              );
            })}
          </div>

          <p className="eyebrow pb-1.5 pt-3 text-faint">Colour</p>
          <div
            role="radiogroup"
            aria-label="Colour"
            className="grid grid-cols-6 gap-1.5"
          >
            {AVATAR_COLORS.map((color) => {
              const chosen = color === avatar.color;
              return (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  aria-label={COLOR_LABELS[color]}
                  title={COLOR_LABELS[color]}
                  onClick={() => pick({ glyph: avatar.glyph, color })}
                  className={`rounded-full p-0.5 ring-2 transition-shadow ${
                    chosen
                      ? "ring-signal"
                      : "ring-transparent hover:ring-line-strong"
                  }`}
                >
                  <span
                    className="block aspect-square w-full rounded-full"
                    style={{ backgroundColor: COLOR_ART[color].disc }}
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
