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
import { Avatar } from "./Avatar";
import { COLOR_ART, COLOR_LABELS, GLYPH_LABELS } from "./avatarArt";

/** The signed-in user's picture: their pick, or the default the server would give. */
export function UserAvatar({
  userId,
  className,
}: {
  userId: string;
  className?: string;
}) {
  const profile = useProfileQuery(userId);
  return (
    <Avatar
      avatar={profile.data?.avatar ?? defaultAvatar(userId)}
      className={className}
    />
  );
}

/**
 * A glyph, and the colour it sits on. Each pick saves at once; there's no
 * Save button to forget.
 */
export function AvatarPicker({ userId }: { userId: string }) {
  const profile = useProfileQuery(userId);
  const updateAvatar = useUpdateAvatarMutation(userId);

  // Until the server answers, the default it would answer with.
  const avatar = profile.data?.avatar ?? defaultAvatar(userId);
  const pick = (next: AvatarIds) => {
    if (next.glyph === avatar.glyph && next.color === avatar.color) return;
    updateAvatar.mutate(next);
  };

  return (
    <div className="w-full max-w-[15.5rem]">
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
  );
}
