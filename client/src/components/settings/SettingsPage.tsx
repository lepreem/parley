import type { ReactNode } from "react";
import { authLoginUrl } from "../../config";
import { useAuth } from "../../hooks/auth/useAuth";
import { useTier } from "../../hooks/auth/useCapabilities";
import { useServer } from "../../hooks/server/useServer";
import { useTheme } from "../../hooks/theme/useTheme";
import {
  MODES,
  THEMES,
  type Mode,
  type ThemeId,
} from "../../hooks/theme/themes";
import { AvatarPicker, UserAvatar } from "../avatar/AvatarPicker";
import { buttonClass } from "../ui/buttonClass";
import { Icon, type IconName } from "../ui/Icon";

const MODE_OPTIONS: Record<Mode, { label: string; icon: IconName }> = {
  light: { label: "Light", icon: "sun" },
  dark: { label: "Dark", icon: "moon" },
  system: { label: "System", icon: "monitor" },
};

/**
 * What a person picks for themselves: their account, on the cloud, and how
 * the app looks on this device.
 */
export function SettingsPage() {
  const server = useServer();
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8">
        {server.signIn === "session" && <AccountSection />}
        <SettingsSection
          id="appearance"
          title="Appearance"
          hint="Saved on this device only."
        >
          <ModePicker />
          <ThemePicker />
        </SettingsSection>
      </div>
    </main>
  );
}

function SettingsSection({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="rounded-2xl border border-line bg-surface p-5"
    >
      <h2 id={`${id}-heading`} className="text-base font-semibold">
        {title}
      </h2>
      <p className="mt-0.5 text-sm text-muted">{hint}</p>
      <div className="mt-5 space-y-6">{children}</div>
    </section>
  );
}

function AccountSection() {
  const { user, signOut } = useAuth();
  const guest = useTier() === "guest";
  if (!user) return null;

  if (guest) {
    return (
      <SettingsSection
        id="account"
        title="Account"
        hint="You're chatting as a guest."
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-sm text-sm text-muted">
            Sign in to keep your chats and add files. What you've started comes
            with you.
          </p>
          <a href={authLoginUrl()} className={buttonClass("primary")}>
            Sign in
          </a>
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      id="account"
      title="Account"
      hint="Your picture shows on every device you sign in on."
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <UserAvatar userId={user.userId} className="h-16 w-16 shrink-0" />
        <AvatarPicker userId={user.userId} />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line pt-5">
        <p className="text-sm text-muted">Signed in on this browser.</p>
        <button
          type="button"
          onClick={() => void signOut()}
          className={buttonClass("secondary")}
        >
          Sign out
        </button>
      </div>
    </SettingsSection>
  );
}

function ModePicker() {
  const { mode, setMode } = useTheme();
  return (
    <div>
      <p className="eyebrow pb-2 text-faint">Mode</p>
      <div
        role="radiogroup"
        aria-label="Mode"
        className="inline-grid grid-cols-3 rounded-lg border border-line bg-sunk p-0.5"
      >
        {MODES.map((option) => {
          const chosen = option === mode;
          const { label, icon } = MODE_OPTIONS[option];
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={chosen}
              onClick={() => setMode(option)}
              className={`flex items-center justify-center gap-1.5 rounded-md px-4 py-1.5 text-[13px] font-medium transition-colors ${
                chosen
                  ? "bg-signal-tint text-signal-ink"
                  : "text-muted hover:text-ink"
              }`}
            >
              <Icon name={icon} className="h-3.5 w-3.5" />
              {label}
            </button>
          );
        })}
      </div>
      {mode === "system" && (
        <p className="mt-2 text-xs text-faint">
          Follows your computer's light or dark setting.
        </p>
      )}
    </div>
  );
}

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <p className="eyebrow pb-2 text-faint">Theme</p>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {THEMES.map(({ id, label, blurb }) => {
          const chosen = id === theme;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={chosen}
              onClick={() => setTheme(id)}
              className={`group overflow-hidden rounded-xl border text-left transition-colors ${
                chosen
                  ? "border-signal ring-1 ring-signal"
                  : "border-line hover:border-line-strong"
              }`}
            >
              <ThemePreview id={id} />
              <span className="flex items-start gap-2 border-t border-line bg-surface px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">
                    {label}
                  </span>
                  <span className="block truncate text-xs text-faint">
                    {blurb}
                  </span>
                </span>
                {chosen && (
                  <Icon
                    name="check"
                    className="mt-0.5 h-4 w-4 shrink-0 text-signal-ink"
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A small sketch of the app in a palette: sidebar, a question, an answer and
 * the send button. It sets data-theme itself, so it shows that palette in the
 * page's current mode.
 */
function ThemePreview({ id }: { id: ThemeId }) {
  return (
    <span
      data-theme={id}
      aria-hidden="true"
      className="flex h-24 bg-canvas text-ink"
    >
      <span className="flex w-1/4 flex-col gap-1.5 border-r border-line bg-sunk p-2">
        <span className="h-1.5 w-3 rounded-full bg-signal" />
        <span className="h-1 w-full rounded-full bg-line-strong" />
        <span className="h-1 w-3/4 rounded-full bg-line" />
        <span className="h-1 w-5/6 rounded-full bg-line" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="ml-auto h-3 w-2/5 rounded-md bg-signal-tint" />
        <span className="h-1 w-5/6 rounded-full bg-muted/60" />
        <span className="h-1 w-2/3 rounded-full bg-faint/60" />
        <span className="mt-auto flex h-4 items-center justify-end rounded-md border border-line bg-surface px-0.5">
          <span className="flex h-3 w-3 items-center justify-center rounded-full bg-signal">
            <span className="h-1 w-1 rounded-full bg-on-signal" />
          </span>
        </span>
      </span>
    </span>
  );
}
