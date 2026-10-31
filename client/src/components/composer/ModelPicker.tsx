import { useMemo, useState } from "react";
import {
  describeModel,
  findChatModel,
  describePricing,
  meetsRequirements,
  priceTier,
  type ChatModel,
  type MessageRequirements,
  type ModelPricing,
} from "../../api/models";
import { useServer } from "../../hooks/server/useServer";
import { fuzzyScoreAny } from "../../lib/fuzzy";
import { Icon } from "../ui/Icon";
import { useDismissable } from "../ui/useDismissable";

type ModelPickerProps = {
  models: ChatModel[];
  value: string | null;
  onChange: (modelId: string) => void;
  /** What the message being written needs; models that can't serve it are hidden. */
  requirements: MessageRequirements;
  loading: boolean;
  error: string | null;
};

type Entry = {
  id: string;
  model: ChatModel;
  provider: string;
  name: string;
  score: number;
  /** Why it's folded away with the archived models, if it is. */
  archived: { text: string; title: string } | null;
};

/** A provider's models while browsing, the archived ones folded away. */
type Group = { label: string; current: Entry[]; archived: Entry[] };

/** Newest first. */
function byRelease(a: Entry, b: Entry): number {
  return (
    (b.model.released ?? "").localeCompare(a.model.released ?? "") ||
    a.name.localeCompare(b.name)
  );
}

/** "2026-11-03" as "3 Nov 2026". */
function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Why the server archived it: a newer model from its provider replaces it,
 * or the provider has said when it goes.
 */
function archivedBecause(
  model: ChatModel,
  byId: ReadonlyMap<string, ChatModel>,
): Entry["archived"] {
  const replacement = model.replacedBy && byId.get(model.replacedBy);
  if (replacement)
    return {
      text: `Replaced by ${describeModel(replacement).name}`,
      title: "Newer, from the same provider, and costs no more",
    };
  if (model.retires)
    return {
      text: `Retires ${formatDay(model.retires)}`,
      title: "The provider has said it will stop serving it",
    };
  return null;
}

/** "2026-10-07" as "Oct 2026". */
function formatReleased(released: string): string {
  return new Date(`${released}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatContext(tokens: number | null): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * The model's price tier as dollar signs, the ones it doesn't reach dimmed,
 * with the exact price on hover. Nothing for a model with no per-token price.
 */
function PriceTier({ pricing }: { pricing: ModelPricing | null }) {
  const tier = priceTier(pricing);
  if (!pricing || !tier) return null;
  const exact = describePricing(pricing);

  if (tier.kind === "free") {
    return (
      <span
        title={exact}
        className="shrink-0 font-mono text-[10px] text-signal"
      >
        free
      </span>
    );
  }
  return (
    <span
      title={exact}
      aria-label={`Price: ${exact}`}
      className="shrink-0 font-mono text-[11px] tracking-tight"
    >
      <span aria-hidden className="text-muted">
        {"$".repeat(tier.dollars)}
      </span>
      <span aria-hidden className="text-faint opacity-50">
        {"$".repeat(3 - tier.dollars)}
      </span>
      {tier.premium && (
        <span aria-hidden className="text-muted">
          +
        </span>
      )}
    </span>
  );
}

export function ModelPicker({
  models,
  value,
  onChange,
  requirements,
  loading,
  error,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  // The providers whose archived models are unfolded.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const recommendedIds = useServer().recommendedChatModelIds;
  const menuRef = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  const byId = useMemo(
    () => new Map(models.map((model) => [model.id, model])),
    [models],
  );

  // Requirement filtering happens before anything the user drives, so the
  // provider counts and the search both describe what is actually selectable.
  const eligible = useMemo(
    () =>
      models
        .filter((model) => meetsRequirements(model, requirements))
        .map((model) => {
          const { provider: label, name } = describeModel(model);
          return {
            id: model.id,
            model,
            provider: label,
            name,
            score: 0,
            archived: archivedBecause(model, byId),
          } satisfies Entry;
        }),
    [models, requirements, byId],
  );

  // Keyed by the display label, as the list's groups are: one provider can
  // publish under several id prefixes ("meta" and "meta-llama", and the "~"
  // aliases), and keying by prefix listed it once per prefix. The counts
  // leave out archived models, as the list does until they're unfolded.
  const providers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of eligible) {
      counts.set(
        entry.provider,
        (counts.get(entry.provider) ?? 0) + (entry.archived ? 0 : 1),
      );
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [eligible]);

  const matches = useMemo(() => {
    const query = search.trim();
    const scored = eligible.flatMap((entry) => {
      if (provider && entry.provider !== provider) return [];
      const score = fuzzyScoreAny(
        [entry.name, entry.id, entry.provider],
        query,
      );
      return score === null ? [] : [{ ...entry, score }];
    });
    // A search finds archived models too, after the current ones that
    // match as well.
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Number(!!a.archived) - Number(!!b.archived) ||
        byRelease(a, b),
    );
    return scored;
  }, [eligible, provider, search]);

  // Grouping only makes sense while browsing: a search is ranked by relevance
  // across every provider. Each provider's archived models fold away under
  // its current ones. The recommended models lead, and stay in their
  // providers' groups as well.
  const grouped = useMemo(() => {
    if (search.trim()) return null;
    const groups = new Map<string, Group>();
    for (const entry of matches) {
      const group = groups.get(entry.provider) ?? {
        label: entry.provider,
        current: [],
        archived: [],
      };
      (entry.archived ? group.archived : group.current).push(entry);
      groups.set(entry.provider, group);
    }
    for (const group of groups.values()) {
      group.current.sort(byRelease);
      group.archived.sort(byRelease);
    }
    const byProvider = [...groups.values()].sort(
      (a, b) =>
        b.current.length - a.current.length || a.label.localeCompare(b.label),
    );
    if (provider) return byProvider;
    // Recommendations may name a model by alias, to follow its newest.
    const recommended = recommendedIds.flatMap((id) => {
      const model = findChatModel(
        matches.map((match) => match.model),
        id,
      );
      const entry = model && matches.find((match) => match.id === model.id);
      return entry ? [entry] : [];
    });
    return recommended.length > 0
      ? [
          { label: "Recommended", current: recommended, archived: [] },
          ...byProvider,
        ]
      : byProvider;
  }, [matches, provider, search, recommendedIds]);

  const toggleArchived = (label: string) =>
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(label)) next.add(label);
      return next;
    });

  const selected = eligible.find((entry) => entry.id === value);
  // Only worth saying when it actually cost the user options.
  const excluded = models.length - eligible.length;
  const currentCount = eligible.filter((entry) => !entry.archived).length;

  if (error) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-live">
        <Icon name="alert" className="h-3.5 w-3.5" />
        {error}
      </span>
    );
  }

  const row = (entry: Entry) => {
    const limit = formatContext(entry.model.contextTokens);
    const released =
      entry.model.released && formatReleased(entry.model.released);
    return (
      <button
        key={entry.id}
        type="button"
        onClick={() => {
          onChange(entry.id);
          setOpen(false);
          setSearch("");
        }}
        className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-sunk"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm text-ink">{entry.name}</span>
            <PriceTier pricing={entry.model.pricing} />
          </span>
          <span className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-faint">
            <span className="truncate">{entry.id}</span>
            {limit && <span className="shrink-0">· {limit}</span>}
            {released && <span className="shrink-0">· {released}</span>}
          </span>
          {entry.archived && (
            <span
              title={entry.archived.title}
              className="mt-0.5 block truncate text-[11px] text-faint"
            >
              {entry.archived.text}
            </span>
          )}
        </span>

        <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
          {entry.model.acceptsImages && (
            <Icon name="eye" className="h-3.5 w-3.5 text-faint" />
          )}
          {entry.id === value && (
            <Icon name="check" className="h-4 w-4 text-signal" />
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={loading}
        aria-label="Choose the chat model"
        aria-expanded={open}
        className="flex max-w-[15rem] items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-muted transition-colors hover:bg-sunk hover:text-ink disabled:opacity-40"
      >
        <span className="truncate">
          {loading ? "loading models…" : (selected?.name ?? "no model")}
        </span>
        <Icon name="chevronDown" className="h-3.5 w-3.5 shrink-0" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-10 left-0 z-30 flex h-[26rem] w-[34rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
            <Icon name="search" className="h-4 w-4 shrink-0 text-faint" />
            <input
              autoFocus
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search models"
              aria-label="Search models"
              className="w-full bg-transparent text-sm outline-none placeholder:text-faint"
            />
            <span className="shrink-0 font-mono text-[10px] text-faint">
              {matches.length}
            </span>
          </div>

          {excluded > 0 && (
            <p className="shrink-0 border-b border-line bg-signal-tint px-3 py-1.5 text-[11px] text-signal-strong">
              {requirements.image
                ? `${excluded} models hidden — this conversation carries an image`
                : `${excluded} models hidden — this conversation is too long for them`}
            </p>
          )}

          <div className="flex min-h-0 flex-1">
            <div className="w-36 shrink-0 overflow-y-auto border-r border-line py-1">
              <button
                type="button"
                onClick={() => setProvider(null)}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors ${
                  provider === null
                    ? "bg-signal-tint text-signal-strong"
                    : "text-muted hover:bg-sunk hover:text-ink"
                }`}
              >
                <span className="truncate">All</span>
                <span className="font-mono text-[10px]">{currentCount}</span>
              </button>
              {providers.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => setProvider(item.label)}
                  title={item.label}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors ${
                    provider === item.label
                      ? "bg-signal-tint text-signal-strong"
                      : "text-muted hover:bg-sunk hover:text-ink"
                  }`}
                >
                  <span className="truncate">{item.label}</span>
                  <span className="font-mono text-[10px]">{item.count}</span>
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {matches.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-faint">
                  No model matches that.
                </p>
              ) : grouped ? (
                grouped.map((group) => (
                  <div key={group.label}>
                    <p className="eyebrow sticky top-0 bg-surface px-3 py-1.5 text-faint">
                      {group.label}
                    </p>
                    {group.current.map(row)}
                    {group.archived.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleArchived(group.label)}
                          aria-expanded={unfolded.has(group.label)}
                          className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-[11px] text-faint transition-colors hover:text-ink"
                        >
                          <Icon
                            name="chevronDown"
                            className={`h-3 w-3 transition-transform ${
                              unfolded.has(group.label) ? "" : "-rotate-90"
                            }`}
                          />
                          {group.archived.length} archived
                        </button>
                        {unfolded.has(group.label) && group.archived.map(row)}
                      </>
                    )}
                  </div>
                ))
              ) : (
                matches.map(row)
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
