import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  FEATURES,
  TIERS,
  UNLIMITED,
  howToReach,
} from "@parley/contract/tiers";
import { refusalOf } from "../../src/middleware/auth.middleware";

describe("the tier ladder", () => {
  it("never takes away on a higher tier what a lower one has", () => {
    for (let i = 1; i < TIERS.length; i++) {
      const below = CAPABILITIES[TIERS[i - 1]!];
      const here = CAPABILITIES[TIERS[i]!];
      for (const feature of FEATURES) {
        if (below[feature]) expect(here[feature], feature).toBe(true);
      }
      if (here.modelPriceCeiling !== null) {
        expect(below.modelPriceCeiling).not.toBeNull();
        expect(
          here.modelPriceCeiling.inputPerMillionTokens,
        ).toBeGreaterThanOrEqual(
          below.modelPriceCeiling!.inputPerMillionTokens,
        );
        expect(
          here.modelPriceCeiling.outputPerMillionTokens,
        ).toBeGreaterThanOrEqual(
          below.modelPriceCeiling!.outputPerMillionTokens,
        );
      }
    }
  });

  it("gives guests text chat on cheap models, and signed-in users everything", () => {
    expect(CAPABILITIES.guest).toEqual({
      attachments: false,
      dictation: false,
      chooseEffort: false,
      webSearch: false,
      projects: false,
      modelPriceCeiling: {
        inputPerMillionTokens: 0.1,
        outputPerMillionTokens: 0.5,
      },
    });
    expect(CAPABILITIES.free).toEqual(UNLIMITED);
  });

  it("tells a guest to sign in for what they lack", () => {
    expect(howToReach("guest", "webSearch")).toBe("sign in");
    expect(howToReach("guest")).toBe("sign in");
    expect(howToReach("free")).toBeUndefined();
    expect(refusalOf("guest", "attachments")).toBe("Sign in to add files");
    expect(refusalOf("guest", "dictation")).toBe("Sign in to dictate");
  });
});
