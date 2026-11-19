/**
 * What each kind of user can do: the one place the client and the cloud
 * server read it from. The server enforces it; the client only hides what the
 * server would refuse.
 *
 * Tiers are a ladder. Each one is the tier below it plus what it `adds`, so a
 * higher tier can't lose a feature by mistake: there's no way to write that.
 * To add a tier, put its name in TIERS at its place and give it a rung;
 * everything keyed by Tier then fails to compile until it says what the new
 * tier gets.
 */
import type { ModelPricing } from "./contract";

/** Lowest first. */
export const TIERS = ["guest", "free"] as const;
export type Tier = (typeof TIERS)[number];

/** What a tier switches on, and keeps switched on for every tier above it. */
export const FEATURES = [
  /** Images in a message, audio and video files, YouTube links. */
  "attachments",
  "dictation",
  /** Picking how hard a reasoning model thinks; otherwise left to the model. */
  "chooseEffort",
  /** Letting the model search the web and open pages. */
  "webSearch",
  /** Grouping chats into projects, each with its own instructions. */
  "projects",
] as const;
export type Feature = (typeof FEATURES)[number];

export type Capabilities = Record<Feature, boolean> & {
  /**
   * The most a model may cost per million tokens, input and output both, or
   * null for any model. A model without a fixed price is over any ceiling.
   */
  modelPriceCeiling: ModelPricing | null;
};

type Rung = {
  /**
   * What someone on a lower tier does to get here, as it finishes "… to use
   * it". Null for the bottom rung, which nobody climbs to.
   */
  reachedBy: string | null;
  /** The features this tier has that the one below doesn't. */
  adds: readonly Feature[];
  /** Left out, the ceiling of the tier below. */
  modelPriceCeiling?: ModelPricing | null;
};

const LADDER: Record<Tier, Rung> = {
  guest: {
    reachedBy: null,
    adds: [],
    // GPT-6 Luna's price. A price rather than a model, so guest chat doesn't
    // end when one model leaves the catalog.
    modelPriceCeiling: {
      inputPerMillionTokens: 0.1,
      outputPerMillionTokens: 0.5,
    },
  },
  free: {
    reachedBy: "sign in",
    adds: ["attachments", "dictation", "chooseEffort", "webSearch", "projects"],
    modelPriceCeiling: null,
  },
};

function climb(): Record<Tier, Capabilities> {
  const none = Object.fromEntries(
    FEATURES.map((feature) => [feature, false]),
  ) as Record<Feature, boolean>;
  let below: Capabilities = { ...none, modelPriceCeiling: null };
  const result = {} as Record<Tier, Capabilities>;
  for (const tier of TIERS) {
    const rung = LADDER[tier];
    const here: Capabilities = {
      ...below,
      modelPriceCeiling:
        rung.modelPriceCeiling === undefined
          ? below.modelPriceCeiling
          : rung.modelPriceCeiling,
    };
    for (const feature of rung.adds) here[feature] = true;
    result[tier] = here;
    below = here;
  }
  return result;
}

export const CAPABILITIES: Readonly<Record<Tier, Readonly<Capabilities>>> =
  climb();

/** Everything, for a server with no sign-in: the one on this computer. */
export const UNLIMITED: Readonly<Capabilities> = {
  ...(Object.fromEntries(FEATURES.map((feature) => [feature, true])) as Record<
    Feature,
    boolean
  >),
  modelPriceCeiling: null,
};

export function isTier(value: unknown): value is Tier {
  return (TIERS as readonly unknown[]).includes(value);
}

/** Whether a model at this price is one the capabilities allow. */
export function allowsModelPrice(
  { modelPriceCeiling: ceiling }: Capabilities,
  pricing: ModelPricing | null,
): boolean {
  if (ceiling === null) return true;
  return (
    pricing !== null &&
    pricing.inputPerMillionTokens <= ceiling.inputPerMillionTokens &&
    pricing.outputPerMillionTokens <= ceiling.outputPerMillionTokens
  );
}

/**
 * What someone on this tier does to get a feature they lack, or to get the
 * next tier when there's no feature to name ("sign in"). Undefined when no
 * tier above has it.
 */
export function howToReach(tier: Tier, feature?: Feature): string | undefined {
  const above = TIERS.slice(TIERS.indexOf(tier) + 1);
  const target = feature
    ? above.find((higher) => CAPABILITIES[higher][feature])
    : above[0];
  return target ? (LADDER[target].reachedBy ?? undefined) : undefined;
}

/**
 * A session's tier as the cloud server reports it, with each auth answer:
 * /auth/me, /auth/guest and /auth/refresh. The capabilities come with it so a
 * client built before a tier existed still shows what that tier can do.
 */
export type TierReport = { tier: Tier; capabilities: Capabilities };

export function tierReport(tier: Tier): TierReport {
  return { tier, capabilities: CAPABILITIES[tier] };
}
