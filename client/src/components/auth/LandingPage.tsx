import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { authGuestEndpoint, authLoginUrl, cloudServer } from "../../config";
import { useAuth } from "../../hooks/auth/useAuth";
import { useTheme } from "../../hooks/theme/useTheme";
import { useToast } from "../../hooks/toast/useToast";
import { queryKeys } from "../../lib/queryClient";
import { Icon } from "../ui/Icon";
import { Meter } from "../ui/Meter";

/**
 * The hero is the thing this app actually does that others don't: one message
 * carrying several recordings. So the hero *is* the composer, mid-transcription.
 */
function ComposerPreview() {
  return (
    <div
      aria-hidden="true"
      className="w-full max-w-[34rem] rounded-2xl border border-line bg-surface p-3 shadow-sm"
    >
      <ul className="mb-3 flex flex-wrap gap-2">
        <li className="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2">
          <Meter state="live" />
          <span>
            <span className="block font-mono text-[11px]">
              board-call-oct.m4a
            </span>
            <span className="block text-[11px] text-faint">transcribing</span>
          </span>
        </li>
        <li className="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2">
          <Meter state="ready" />
          <span>
            <span className="block font-mono text-[11px]">
              youtube/q1-briefing
            </span>
            <span className="block text-[11px] text-faint">
              ready · 41,208 chars
            </span>
          </span>
        </li>
      </ul>

      <p className="px-1 pb-3 text-[15px] text-muted">
        Where do these two disagree?
      </p>

      <div className="flex items-center gap-2 px-1">
        <Icon name="plus" className="h-5 w-5 text-faint" />
        <span className="font-mono text-[11px] text-faint">
          anthropic/claude-sonnet-5
        </span>
        <span className="flex-1" />
        <span className="rounded-full bg-line p-2 text-faint">
          <Icon name="send" className="h-4 w-4" />
        </span>
      </div>
    </div>
  );
}

/** Whether the cloud lets people chat without signing in. */
async function fetchGuestChatEnabled(): Promise<boolean> {
  const res = await fetch(authGuestEndpoint(), { credentials: "include" });
  if (!res.ok) return false;
  const { enabled } = (await res.json()) as { enabled?: unknown };
  return enabled === true;
}

/**
 * Chat on the cloud as a guest, in text only. Signing in later keeps what
 * they wrote: the server moves it to their account.
 */
function GuestButton() {
  const { continueAsGuest } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const enabled = useQuery({
    queryKey: queryKeys.guestChat(cloudServer.id),
    queryFn: fetchGuestChatEnabled,
    staleTime: Infinity,
  });
  if (!enabled.data) return null;

  const start = async () => {
    setStarting(true);
    try {
      await continueAsGuest();
      navigate(cloudServer.appPath, { replace: true });
    } catch {
      toast.show({
        kind: "error",
        message: "Couldn't start a guest chat. Try again in a moment.",
      });
      setStarting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={starting}
      className="inline-flex items-center rounded-lg border border-line px-5 py-2.5 text-sm font-medium text-muted transition-colors hover:border-signal hover:text-ink disabled:opacity-60"
    >
      Try it without an account
    </button>
  );
}

export function LandingPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between px-5">
        <span className="eyebrow text-ink">Parley</span>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          className="rounded-lg p-2 text-muted transition-colors hover:bg-sunk hover:text-ink"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} className="h-4 w-4" />
        </button>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-10 px-5 py-14 text-center">
        <div className="max-w-xl">
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Several recordings.
            <br />
            <span className="text-signal-strong dark:text-signal">
              One question.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Drop audio, video or a YouTube link. Each becomes a transcript, and
            one message carries as many as the question needs.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={authLoginUrl()}
              className="inline-flex items-center rounded-lg bg-signal px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              Sign in
            </a>
            <GuestButton />
            {/* No account needed: the local server runs on the user's machine. */}
            <Link
              to="/local"
              className="inline-flex items-center rounded-lg border border-line px-5 py-2.5 text-sm font-medium text-muted transition-colors hover:border-signal hover:text-ink"
            >
              Use this computer
            </Link>
          </div>
        </div>

        <ComposerPreview />
      </main>
    </div>
  );
}
