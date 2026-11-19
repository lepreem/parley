import { describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";

import { verify as verifyAccessToken } from "../../src/auth/accessToken";
import { signAccessToken, signTestToken } from "../helpers/accessTokens";

const userId = "user_01ACCESS";
const sessionId = "session_01ACCESS";
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("verifyAccessToken", () => {
  it("returns who the token is for, its session and its expiry", async () => {
    const expiresAtEpochSeconds = nowSeconds() + 300;
    const token = await signAccessToken({
      userId,
      sessionId,
      expiresAtEpochSeconds,
    });

    await expect(verifyAccessToken(token)).resolves.toEqual({
      userId,
      sessionId,
      expiresAtEpochSeconds,
    });
  });

  it("rejects an expired token", async () => {
    const token = await signAccessToken({
      userId,
      sessionId,
      expiresAtEpochSeconds: nowSeconds() - 60,
    });

    await expect(verifyAccessToken(token)).rejects.toThrow('"exp"');
  });

  it("reads an expired token when the caller allows it", async () => {
    const token = await signAccessToken({
      userId,
      sessionId,
      expiresAtEpochSeconds: nowSeconds() - 60,
    });

    await expect(
      verifyAccessToken(token, { allowExpired: true }),
    ).resolves.toMatchObject({ userId, sessionId });
  });

  it("rejects a token signed with a key WorkOS didn't publish", async () => {
    // Claims the published key's ID, so only the signature can give it away.
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: userId, sid: sessionId })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setExpirationTime(nowSeconds() + 300)
      .sign(privateKey);

    await expect(verifyAccessToken(token)).rejects.toThrow("signature");
  });

  it.each([
    ["a user ID", { sid: sessionId }, "Access token is missing a user ID"],
    ["a session ID", { sub: userId }, "Access token is missing a session ID"],
  ])("rejects a token without %s", async (_, claims, message) => {
    const token = await signTestToken({ ...claims, exp: nowSeconds() + 300 });

    await expect(verifyAccessToken(token)).rejects.toThrow(message);
  });

  it("rejects a token without an expiry", async () => {
    const token = await signTestToken({ sub: userId, sid: sessionId });

    await expect(verifyAccessToken(token)).rejects.toThrow(
      "Access token is missing an expiry",
    );
  });
});
