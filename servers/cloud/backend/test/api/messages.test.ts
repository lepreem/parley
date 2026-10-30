import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFindOwnedConversation,
  mockClaimConversationTurn,
  mockUnclaimConversationTurn,
  mockFindContextHistory,
  mockPersistAndUnclaimChatTurn,
  mockFindConversationMessages,
  mockDeleteOwnedMessage,
  mockResolveImages,
  mockResolveMessageImages,
  mockResolveImageAttachmentUrls,
  mockFindMessageTranscriptAttachments,
  mockFindTranscripts,
  mockDeleteObjects,
  mockFindChatModel,
  mockChatAI,
  mockGenerateTitle,
  mockIsGuestModel,
  mockClaimAttachments,
  mockUnclaimAttachments,
} = vi.hoisted(() => ({
  mockFindOwnedConversation: vi.fn(),
  mockClaimConversationTurn: vi.fn(),
  mockUnclaimConversationTurn: vi.fn(),
  mockFindContextHistory: vi.fn(),
  mockPersistAndUnclaimChatTurn: vi.fn(),
  mockFindConversationMessages: vi.fn(),
  mockDeleteOwnedMessage: vi.fn(),
  mockResolveImages: vi.fn(),
  mockResolveMessageImages: vi.fn(),
  mockResolveImageAttachmentUrls: vi.fn(),
  mockFindMessageTranscriptAttachments: vi.fn(),
  mockFindTranscripts: vi.fn(),
  mockDeleteObjects: vi.fn(),
  mockFindChatModel: vi.fn(),
  mockChatAI: vi.fn(),
  mockGenerateTitle: vi.fn(),
  mockIsGuestModel: vi.fn(),
  mockClaimAttachments: vi.fn(),
  mockUnclaimAttachments: vi.fn(),
}));

vi.mock("../../src/data/attachments.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/attachments.data")>();
  return {
    ...actual,
    attachments: {
      ...actual.attachments,
      claimAttachments: mockClaimAttachments,
      unclaimAttachments: mockUnclaimAttachments,
    },
  };
});

// The data layer is mocked directly — these tests drive the controller's
// context assembly, streaming and (non-blocking) persistence, not the SQL. The
// join queries behind the history loaders are a data-layer concern. The
// table stubs stand in for the columns other controllers read at module scope
// when createApp wires the whole app.
vi.mock("../../src/db", async () => ({
  db: {},
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../src/data/conversations.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/conversations.data")>();
  return {
    ...actual,
    conversations: {
      ...actual.conversations,
      findOwnedConversation: mockFindOwnedConversation,
      claimConversationTurn: mockClaimConversationTurn,
      unclaimConversationTurn: mockUnclaimConversationTurn,
    },
  };
});

vi.mock("../../src/data/messages.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/messages.data")>();
  return {
    ...actual,
    messages: {
      ...actual.messages,
      findContextHistory: mockFindContextHistory,
      persistAndUnclaimChatTurn: mockPersistAndUnclaimChatTurn,
      findConversationMessages: mockFindConversationMessages,
      deleteOwnedMessage: mockDeleteOwnedMessage,
    },
  };
});

vi.mock("../../src/data/images.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/images.data")>();
  return {
    ...actual,
    images: {
      ...actual.images,
      resolveImages: mockResolveImages,
      resolveMessageImages: mockResolveMessageImages,
      resolveImageAttachmentUrls: mockResolveImageAttachmentUrls,
    },
  };
});

vi.mock("../../src/data/transcripts.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/data/transcripts.data")>();
  return {
    ...actual,
    transcripts: {
      ...actual.transcripts,
      findMessageTranscriptAttachments: mockFindMessageTranscriptAttachments,
      findTranscripts: mockFindTranscripts,
      linkTranscriptionsToMessage: vi.fn(),
    },
  };
});

// Controllers release deleted objects through the upload module.
vi.mock("../../src/uploads", () => ({
  uploads: { deleteObjects: mockDeleteObjects },
}));

vi.mock("../../src/storage/bucket", () => ({
  bucket: {
    delete: vi.fn(),
  },
}));

vi.mock("../../src/storage/sign", () => ({
  IMAGE_URL_TTL_SECONDS: 7 * 24 * 60 * 60,
  sign: {
    urls: vi.fn(),
  },
}));

// buildUserTurn is the real one: what the model is handed for an image turn is
// exactly what these tests are checking.
vi.mock("../../src/ai/ai_chat_client", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/ai/ai_chat_client")>();
  return {
    ...actual,
    chat: {
      ...actual.chat,
      findModel: mockFindChatModel,
      complete: mockChatAI,
      generateTitle: mockGenerateTitle,
      isGuestModel: mockIsGuestModel,
    },
  };
});

// The real timing, watched: these tests check which steps get timed together.
vi.mock("../../src/preparationMetrics", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/preparationMetrics")>();
  return { ...actual, measurePreparation: vi.fn(actual.measurePreparation) };
});

import { createApp } from "../../src/app";
import { eventHub } from "../../src/sse/hub";
import { resetHistoryTextCache } from "../../src/memory/historyText";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { measurePreparation } from "../../src/preparationMetrics";
import {
  MAX_CONTEXT_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_RESPONSE_TOKENS,
} from "../../src/chat/contextWindow";
import { MAX_TRANSCRIPTS } from "../../src/schema/messages.schema";
import {
  authedHeaders,
  guestCookieHeader,
  sessionCookieHeader,
} from "../helpers/session";
import { type HistoryCandidate } from "../../src/data/messages.data";
import type { ReplyStreamEvents } from "@parley/contract";

const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const messageId = "650e8400-e29b-41d4-a716-446655440111";
const userId = "user_01OWNER";
const modelId = "openai/gpt-4o-mini";
const createdAt = "2026-07-22T00:00:00.000Z";

const imageUploadId = "850e8400-e29b-41d4-a716-446655440333";

const ownedConversation = {
  id: conversationId,
  title: "A chat",
  createdAt,
  updatedAt: createdAt,
  lastMessageId: null,
  activeTurnClaimToken: null,
};

const userRow = {
  id: messageId,
  role: "user",
  content: "Hi there",
  chosenModelId: null,
  stopped: false,
  conversationId,
  createdAt,
};
const assistantRow = {
  id: "750e8400-e29b-41d4-a716-446655440222",
  role: "assistant",
  content: "Hello world",
  chosenModelId: modelId,
  stopped: false,
  conversationId,
  createdAt,
};

/** The data of the `done` event in a reply stream's body. */
function doneOf(body: string): ReplyStreamEvents["done"] {
  const data = /^event: done\ndata: (.*)$/m.exec(body)?.[1];
  if (data === undefined) throw new Error("The stream has no done event");
  return JSON.parse(data) as ReplyStreamEvents["done"];
}

/** A message as the database hands it over, where the JSON has a string. */
function rowOf<Message extends { createdAt: string }>(message: Message) {
  return { ...message, createdAt: new Date(message.createdAt) };
}

const resolvedImage = {
  imageUploadId,
  fileName: "diagram.png",
  mimeType: "image/png",
  size: 1234,
  url: "https://bucket.test/diagram.png",
};

/**
 * A past turn as the history query returns it. `imageUrls` stands in for its
 * images: each is stored already signed, under its own URL as its id, and the
 * default resolveImageAttachmentUrls hands that URL back.
 */
function createMessageHistory(
  partial: Partial<Omit<HistoryCandidate, "images">> & {
    imageUrls?: string[];
  } = {},
): HistoryCandidate {
  const { imageUrls = [], ...candidate } = partial;
  return {
    id: messageId,
    role: "user",
    createdAt: new Date(createdAt),
    content: "",
    transcripts: [],
    images: imageUrls.map((url) => ({
      imageUploadId: url,
      signedUrl: url,
      signedUrlExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })),
    ...candidate,
  };
}

function messageRequestBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const {
    imageUploadIds = [],
    audioUploadIds = [],
    ...requestBody
  } = body as {
    imageUploadIds?: string[];
    audioUploadIds?: string[];
  } & Record<string, unknown>;

  return {
    ...requestBody,
    attachments: [
      ...imageUploadIds.map((imageUploadId) => ({
        type: "image",
        imageUploadId,
      })),
      ...audioUploadIds.map((audioUploadId) => ({
        type: "transcript",
        audioUploadId,
      })),
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every case sends turns; none should spend another's chat-turn budget.
  resetRateLimits();
  resetHistoryTextCache();
  mockFindOwnedConversation.mockResolvedValue(ownedConversation);
  mockClaimConversationTurn.mockImplementation(
    (_userId, _conversationId, _lastMessageId, claimToken = "claim-token") =>
      Promise.resolve(claimToken),
  );
  mockUnclaimConversationTurn.mockResolvedValue(undefined);
  mockClaimAttachments.mockResolvedValue(true);
  mockUnclaimAttachments.mockResolvedValue(undefined);
  mockFindContextHistory.mockResolvedValue([]);
  mockResolveImages.mockResolvedValue([]);
  mockResolveMessageImages.mockResolvedValue(new Map());
  mockResolveImageAttachmentUrls.mockImplementation(
    async (
      _userId: string,
      rows: { imageUploadId: string; signedUrl: string | null }[],
    ) =>
      new Map(
        rows.flatMap((row) =>
          row.signedUrl ? [[row.imageUploadId, row.signedUrl] as const] : [],
        ),
      ),
  );
  mockFindMessageTranscriptAttachments.mockResolvedValue(new Map());
  mockFindTranscripts.mockResolvedValue(new Map());
  mockPersistAndUnclaimChatTurn.mockResolvedValue({
    userMessageId: userRow.id,
    assistantMessageId: assistantRow.id,
  });
  mockDeleteOwnedMessage.mockResolvedValue({
    status: "deleted",
    ids: [messageId],
    imageUploadIds: [],
    lastMessageId: null,
  });
  mockFindChatModel.mockResolvedValue({
    id: modelId,
    name: "Test model",
    contextTokens: null,
    acceptsImages: true,
  });
  mockGenerateTitle.mockResolvedValue("Friendly greeting");
  mockIsGuestModel.mockResolvedValue(true);
  mockDeleteObjects.mockResolvedValue([]);
});

describe("a guest's turn", () => {
  const guestId = "guest_00000000-0000-4000-8000-000000000001";

  async function postAsGuest(
    body: Record<string, unknown>,
    clientIp = "203.0.113.10",
  ) {
    return (await createApp()).request(
      `http://localhost/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: {
          Cookie: await guestCookieHeader(guestId),
          "Content-Type": "application/json",
          "X-Real-IP": clientIp,
        },
        body: JSON.stringify(
          messageRequestBody({ lastMessageId: null, ...body }),
        ),
      },
    );
  }

  beforeEach(() => {
    mockChatAI.mockImplementation(
      async (
        _model: string,
        _turns: unknown,
        opts: { onDelta: (d: string) => Promise<void> },
      ) => {
        await opts.onDelta("Hello");
        return "Hello";
      },
    );
  });

  it("is billed to the guest key, title included", async () => {
    const res = await postAsGuest({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    await res.text();

    expect(res.status).toBe(200);
    expect(mockChatAI).toHaveBeenCalledWith(
      modelId,
      expect.anything(),
      expect.objectContaining({ guest: true }),
    );
    expect(mockGenerateTitle).toHaveBeenCalledWith("conversation", "Hi there", {
      guest: true,
    });
    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: guestId }),
    );
  });

  it("is refused a model that costs more than the guest ones", async () => {
    mockIsGuestModel.mockResolvedValue(false);

    const res = await postAsGuest({
      messageContent: "Hi there",
      chosenModelId: "anthropic/claude-sonnet-5",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: "Invalid model: sign in to use this model",
    });
    expect(mockChatAI).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalled();
  });

  it("gets ten turns a day from one address, across guests", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await postAsGuest({
        messageContent: "Hi there",
        chosenModelId: modelId,
      });
      await res.text();
      expect(res.status).not.toBe(429);
    }

    const limited = await postAsGuest({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(limited.status).toBe(429);
    const elsewhere = await postAsGuest(
      { messageContent: "Hi there", chosenModelId: modelId },
      "203.0.113.11",
    );
    await elsewhere.text();
    expect(elsewhere.status).toBe(200);
  });

  it("doesn't count a signed-in user's turns against the address", async () => {
    for (let i = 0; i < 11; i++) {
      const res = await (
        await createApp()
      ).request(`http://localhost/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: {
          Cookie: await sessionCookieHeader(userId),
          "Content-Type": "application/json",
          "X-Real-IP": "203.0.113.10",
        },
        body: JSON.stringify(
          messageRequestBody({
            lastMessageId: null,
            messageContent: "Hi there",
            chosenModelId: modelId,
          }),
        ),
      });
      await res.text();
      expect(res.status).toBe(200);
    }
    expect(mockIsGuestModel).not.toHaveBeenCalled();
  });
});

describe("GET /conversations/:conversationId/messages", () => {
  it("returns 401 without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request(`http://localhost/conversations/${conversationId}/messages`);
    expect(res.status).toBe(401);
    expect(mockFindOwnedConversation).not.toHaveBeenCalled();
  });

  it("lists the conversation's messages oldest-first", async () => {
    mockFindConversationMessages.mockResolvedValueOnce([
      rowOf(userRow),
      rowOf(assistantRow),
    ]);
    const res = await (
      await createApp()
    ).request(`http://localhost/conversations/${conversationId}/messages`, {
      headers: await authedHeaders(userId),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lastMessageId: null,
      messages: [
        { ...userRow, attachments: [], transcriptAttachments: [] },
        { ...assistantRow, attachments: [], transcriptAttachments: [] },
      ],
      replyInProgress: null,
    });
  });

  it("revalidates unchanged message history with an ETag", async () => {
    mockFindConversationMessages.mockResolvedValue([
      rowOf(userRow),
      rowOf(assistantRow),
    ]);
    const app = await createApp();
    const cookie = await sessionCookieHeader(userId);
    const url = `http://localhost/conversations/${conversationId}/messages`;

    const first = await app.request(url, {
      headers: { Cookie: cookie },
    });
    const etag = first.headers.get("ETag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const second = await app.request(url, {
      headers: { Cookie: cookie, "If-None-Match": etag as string },
    });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("returns each user turn's attachments", async () => {
    mockFindConversationMessages.mockResolvedValueOnce([
      rowOf(userRow),
      rowOf(assistantRow),
    ]);
    mockResolveMessageImages.mockResolvedValueOnce(
      new Map([[messageId, [resolvedImage]]]),
    );
    mockFindMessageTranscriptAttachments.mockResolvedValueOnce(
      new Map([
        [
          messageId,
          [
            {
              imageUploadId: "950e8400-e29b-41d4-a716-446655440444",
              fileName: "interview.mp3",
              title: "Customer interview",
              source: "audio",
              charCount: 120,
            },
          ],
        ],
      ]),
    );

    const res = await (
      await createApp()
    ).request(`http://localhost/conversations/${conversationId}/messages`, {
      headers: await authedHeaders(userId),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lastMessageId: null,
      messages: [
        {
          ...userRow,
          attachments: [resolvedImage],
          transcriptAttachments: [
            {
              imageUploadId: "950e8400-e29b-41d4-a716-446655440444",
              fileName: "interview.mp3",
              title: "Customer interview",
              source: "audio",
            },
          ],
        },
        { ...assistantRow, attachments: [], transcriptAttachments: [] },
      ],
      replyInProgress: null,
    });
  });

  it("returns 404 when the conversation is not owned by the user", async () => {
    mockFindOwnedConversation.mockResolvedValueOnce(null);
    const res = await (
      await createApp()
    ).request(`http://localhost/conversations/${conversationId}/messages`, {
      headers: await authedHeaders(userId),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /conversations/:conversationId/messages", () => {
  function requestClaimToken(): string {
    return mockClaimConversationTurn.mock.calls[0][3];
  }

  function postMessage(body: unknown, signal?: AbortSignal) {
    const requestBody =
      body && typeof body === "object" && !Array.isArray(body)
        ? messageRequestBody({ lastMessageId: null, ...body })
        : body;
    return sessionCookieHeader(userId).then(async (cookie) =>
      (await createApp()).request(
        `http://localhost/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal,
        },
      ),
    );
  }

  it("rejects an attachment that cannot be reserved before starting either model call", async () => {
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockClaimAttachments.mockResolvedValueOnce(false);

    const response = await postMessage({
      messageContent: "Describe this",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    expect(response.status).toBe(404);
    expect(mockChatAI).not.toHaveBeenCalled();
    expect(mockGenerateTitle).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
  });

  it("holds image and transcript reservations while generation is pending", async () => {
    const audioUploadId = "950e8400-e29b-41d4-a716-446655440444";
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockFindTranscripts.mockResolvedValueOnce(
      new Map([[audioUploadId, "Transcript"]]),
    );
    let finishGeneration!: (content: string) => void;
    mockChatAI.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishGeneration = resolve;
        }),
    );

    const response = await postMessage({
      messageContent: "Summarize these",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
      audioUploadIds: [audioUploadId],
    });

    expect(mockClaimAttachments).toHaveBeenCalledWith(
      userId,
      [imageUploadId, audioUploadId],
      requestClaimToken(),
    );
    expect(mockClaimAttachments.mock.invocationCallOrder[0]).toBeLessThan(
      mockChatAI.mock.invocationCallOrder[0],
    );
    expect(mockClaimAttachments.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerateTitle.mock.invocationCallOrder[0],
    );
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();

    finishGeneration("Summary");
    expect(await response.text()).toContain("event: done");
  });

  it("releases reservations when persistence fails after generation", async () => {
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockChatAI.mockResolvedValueOnce("Answer");
    mockPersistAndUnclaimChatTurn.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const response = await postMessage({
      messageContent: "Describe this",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    expect(await response.text()).toContain("event: error");
    expect(mockUnclaimAttachments).toHaveBeenCalledWith(requestClaimToken());
    expect(mockUnclaimConversationTurn).toHaveBeenCalled();
  });

  it("reserves attachments while history is still loading", async () => {
    const history = Promise.withResolvers<HistoryCandidate[]>();
    mockFindContextHistory.mockReturnValueOnce(history.promise);
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockChatAI.mockResolvedValueOnce("Description");

    const responsePromise = postMessage({
      messageContent: "Describe this",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    await vi.waitFor(() =>
      expect(mockClaimAttachments).toHaveBeenCalledWith(
        userId,
        [imageUploadId],
        requestClaimToken(),
      ),
    );
    expect(mockChatAI).not.toHaveBeenCalled();
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
    history.resolve([]);

    const response = await responsePromise;
    expect(await response.text()).toContain("event: done");
    // Saving the turn released both, so there's nothing left to clean up.
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).not.toHaveBeenCalled();
  });

  it("settles late acquisitions before cleanup when a concurrent read fails", async () => {
    const claim = Promise.withResolvers<string>();
    const reservation = Promise.withResolvers<boolean>();
    mockClaimConversationTurn.mockReturnValueOnce(claim.promise);
    mockClaimAttachments.mockReturnValueOnce(reservation.promise);
    mockFindContextHistory.mockRejectedValueOnce(
      new Error("history unavailable"),
    );

    const responsePromise = postMessage({
      messageContent: "Describe this",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    await vi.waitFor(() => expect(mockFindContextHistory).toHaveBeenCalled());
    expect(mockClaimAttachments).toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).not.toHaveBeenCalled();
    claim.resolve(requestClaimToken());
    await vi.waitFor(() => expect(mockClaimAttachments).toHaveBeenCalled());
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).not.toHaveBeenCalled();
    reservation.resolve(true);

    expect((await responsePromise).status).toBe(500);
    expect(mockUnclaimAttachments).toHaveBeenCalledExactlyOnceWith(
      requestClaimToken(),
    );
    expect(mockUnclaimConversationTurn).toHaveBeenCalledExactlyOnceWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
    expect(mockChatAI).not.toHaveBeenCalled();
  });

  it("cleans up the conversation claim when reservation fails", async () => {
    mockClaimAttachments.mockRejectedValueOnce(
      new Error("reservation unavailable"),
    );

    const response = await postMessage({
      messageContent: "Describe this",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    expect(response.status).toBe(500);
    expect(mockUnclaimAttachments).toHaveBeenCalledExactlyOnceWith(
      requestClaimToken(),
    );
    expect(mockUnclaimConversationTurn).toHaveBeenCalledExactlyOnceWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
    expect(mockChatAI).not.toHaveBeenCalled();
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it("waits for a late reservation and releases it when claiming fails", async () => {
    const reservation = Promise.withResolvers<boolean>();
    mockClaimAttachments.mockReturnValueOnce(reservation.promise);
    mockClaimConversationTurn.mockRejectedValueOnce(
      new Error("claim unavailable"),
    );

    const responsePromise = postMessage({
      messageContent: "Hi",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    await vi.waitFor(() => expect(mockClaimAttachments).toHaveBeenCalled());
    expect(mockClaimAttachments).toHaveBeenCalledWith(
      userId,
      [imageUploadId],
      requestClaimToken(),
    );
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).not.toHaveBeenCalled();
    reservation.resolve(true);

    expect((await responsePromise).status).toBe(500);
    expect(mockUnclaimAttachments).toHaveBeenCalledExactlyOnceWith(
      requestClaimToken(),
    );
    expect(mockUnclaimConversationTurn).toHaveBeenCalledExactlyOnceWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
  });

  it("releases reservations when transcript validation fails", async () => {
    const audioUploadId = "950e8400-e29b-41d4-a716-446655440444";
    const response = await postMessage({
      messageContent: "Summarize this",
      chosenModelId: modelId,
      audioUploadIds: [audioUploadId],
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Transcript not found" });
    expect(mockClaimAttachments).toHaveBeenCalledWith(
      userId,
      [audioUploadId],
      requestClaimToken(),
    );
    expect(mockUnclaimAttachments).toHaveBeenCalledExactlyOnceWith(
      requestClaimToken(),
    );
    expect(mockUnclaimConversationTurn).toHaveBeenCalledExactlyOnceWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
  });

  it.each(["reservations", "conversation"])(
    "preserves validation errors when %s cleanup fails",
    async (cleanup) => {
      if (cleanup === "reservations") {
        mockUnclaimAttachments.mockRejectedValueOnce(
          new Error("cleanup unavailable"),
        );
      } else {
        mockUnclaimConversationTurn.mockRejectedValueOnce(
          new Error("cleanup unavailable"),
        );
      }

      const response = await postMessage({
        messageContent: "Describe this",
        chosenModelId: modelId,
        imageUploadIds: [imageUploadId],
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Image not found" });
      expect(mockUnclaimAttachments).toHaveBeenCalledOnce();
      expect(mockUnclaimConversationTurn).toHaveBeenCalledOnce();
    },
  );

  it("keeps protection through persistence after the client disconnects", async () => {
    const client = new AbortController();
    const generation = Promise.withResolvers<string>();
    const persistence = Promise.withResolvers<{
      userMessageId: string;
      assistantMessageId: string;
    }>();
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockChatAI.mockReturnValueOnce(generation.promise);
    mockPersistAndUnclaimChatTurn.mockReturnValueOnce(persistence.promise);

    const response = await postMessage(
      {
        messageContent: "Describe this",
        chosenModelId: modelId,
        imageUploadIds: [imageUploadId],
      },
      client.signal,
    );
    client.abort();
    await response.text().catch(() => {});
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).not.toHaveBeenCalled();

    generation.resolve("Description");
    await vi.waitFor(() =>
      expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalled(),
    );
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).not.toHaveBeenCalled();
    persistence.resolve({
      userMessageId: userRow.id,
      assistantMessageId: assistantRow.id,
    });

    // Saving the turn released both, so there's nothing left to clean up.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).not.toHaveBeenCalled();
  });

  it("requires the client to identify the conversation head", async () => {
    const res = await (
      await createApp()
    ).request(`http://localhost/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        Cookie: await sessionCookieHeader(userId),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messageContent: "Hi there",
        chosenModelId: modelId,
      }),
    });

    expect(res.status).toBe(400);
    expect(mockClaimConversationTurn).not.toHaveBeenCalled();
  });

  it("claims the exact head submitted by the client", async () => {
    mockChatAI.mockResolvedValueOnce("Hello world");

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
      lastMessageId: messageId,
    });
    await res.text();

    expect(mockClaimConversationTurn).toHaveBeenCalledWith(
      userId,
      conversationId,
      messageId,
      requestClaimToken(),
    );
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it("starts the attachment reservation and context reads while the conversation claim is pending", async () => {
    let resolveClaim!: (claimToken: string) => void;
    mockClaimConversationTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClaim = resolve;
        }),
    );
    mockChatAI.mockResolvedValueOnce("Hello world");

    const responsePromise = postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });

    await vi.waitFor(() => {
      expect(mockClaimAttachments).toHaveBeenCalledWith(
        userId,
        [],
        requestClaimToken(),
      );
      expect(mockResolveImages).toHaveBeenCalled();
      expect(mockFindContextHistory).toHaveBeenCalled();
    });

    resolveClaim(requestClaimToken());
    const res = await responsePromise;
    expect(res.status).toBe(200);
    await res.text();
  });

  it("releases an acquired claim when a context read fails", async () => {
    mockFindContextHistory.mockRejectedValueOnce(
      new Error("history unavailable"),
    );

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });

    expect(res.status).toBe(500);
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
    expect(mockChatAI).not.toHaveBeenCalled();
  });

  it("returns 409 without starting the model when the head cannot be claimed", async () => {
    mockClaimConversationTurn.mockResolvedValueOnce(null);

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });

    expect(res.status).toBe(409);
    expect(mockClaimAttachments).toHaveBeenCalledWith(
      userId,
      [],
      requestClaimToken(),
    );
    expect(mockUnclaimAttachments).toHaveBeenCalledExactlyOnceWith(
      requestClaimToken(),
    );
    expect(mockUnclaimConversationTurn).toHaveBeenCalledExactlyOnceWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
    expect(await res.json()).toEqual({
      message: "Conversation changed or a response is already in progress",
    });
    expect(mockChatAI).not.toHaveBeenCalled();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
  });

  it("never compresses the reply stream, even when the client accepts gzip", async () => {
    // Response compression is mounted app-wide. Buffering this stream would
    // turn a token-by-token reply into one chunk at the end: invisible to
    // every other test, obvious to every user.
    mockChatAI.mockImplementation(
      async (
        _model: string,
        _turns: unknown,
        opts: { onDelta: (d: string) => Promise<void> },
      ) => {
        await opts.onDelta("Hello ");
        return "Hello";
      },
    );

    const res = await (
      await createApp()
    ).request(`http://localhost/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        Cookie: await sessionCookieHeader(userId),
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify({
        messageContent: "Hi there",
        chosenModelId: modelId,
        lastMessageId: null,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toContain("event: delta");
  });

  it("streams deltas then the persisted conversation head", async () => {
    mockChatAI.mockImplementation(
      async (
        _model: string,
        _turns: unknown,
        opts: { onDelta: (d: string) => Promise<void> },
      ) => {
        await opts.onDelta("Hello ");
        await opts.onDelta("world");
        return "Hello world";
      },
    );

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    expect(body).toContain("event: delta");
    expect(body).toContain(JSON.stringify({ delta: "Hello " }));
    expect(body).toContain(JSON.stringify({ delta: "world" }));
    expect(doneOf(body)).toMatchObject({
      lastMessageId: assistantRow.id,
      stopped: false,
    });
    expect(body).not.toContain("event: error");
    // The persisted head trails the tokens the client rendered.
    expect(body.indexOf("event: delta")).toBeLessThan(
      body.indexOf("event: done"),
    );

    expect(mockChatAI).toHaveBeenCalledWith(
      modelId,
      [{ role: "user", content: "Hi there" }],
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );

    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        conversationId,
        content: "Hi there",
        assistantContent: "Hello world",
        chosenModelId: modelId,
        attachmentIds: [],
        contextWindowMessageCount: 2,
        conversationTitle: "Friendly greeting",
        claimToken: requestClaimToken(),
      }),
    );
    expect(mockGenerateTitle).toHaveBeenCalledWith("conversation", "Hi there", {
      guest: false,
    });
  });

  it("ends with the turn's stats: its steps, the model's times and its context", async () => {
    mockChatAI.mockImplementation(
      async (
        _model: string,
        _turns: unknown,
        opts: { onDelta: (d: string) => Promise<void> },
      ) => {
        await opts.onDelta("Hello world");
        return "Hello world";
      },
    );

    const response = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    const { stats } = doneOf(await response.text());

    expect(stats).toBeDefined();
    if (!stats) return;
    expect(stats.steps.map((step) => step.operation).sort()).toEqual([
      "claimAttachments",
      "claimConversationTurn",
      "findContextHistory",
      "findTranscripts",
      "persistAndUnclaimChatTurn",
      "resolveImages",
    ]);
    expect(stats.steps.at(-1)?.operation).toBe("persistAndUnclaimChatTurn");
    expect(stats.firstTokenAfterMs).not.toBeNull();
    expect(stats.modelStartedAfterMs).toBeLessThanOrEqual(
      stats.firstTokenAfterMs ?? 0,
    );
    expect(stats.firstTokenAfterMs).toBeLessThanOrEqual(
      stats.modelFinishedAfterMs,
    );
    expect(stats.modelFinishedAfterMs).toBeLessThanOrEqual(stats.totalMs);
    expect(stats.context).toEqual({
      historyReadMessages: 0,
      historyCachedMessages: 0,
      historyMessages: 0,
      historyChars: 0,
      newTurnChars: "Hi there".length,
      maxChars: MAX_CONTEXT_CHARS,
      maxHistoryMessages: MAX_HISTORY_MESSAGES,
    });
  });

  it("counts the history whose text the server already held", async () => {
    const olderId = "650e8400-e29b-41d4-a716-446655440000";
    const older = createMessageHistory({ id: olderId, content: "Earlier" });
    mockFindContextHistory.mockResolvedValueOnce([older]);
    mockFindContextHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: assistantRow.id,
        role: "assistant",
        content: "Hello world",
      }),
      createMessageHistory({ id: userRow.id, content: "Hi there" }),
      older,
      createMessageHistory({ id: "uncached", content: "Not held" }),
    ]);
    mockChatAI.mockResolvedValueOnce("Hello world");
    mockChatAI.mockResolvedValueOnce("Second reply");

    const contexts = [];
    for (const messageContent of ["Hi there", "And again"]) {
      const res = await postMessage({ messageContent, chosenModelId: modelId });
      contexts.push(doneOf(await res.text()).stats?.context);
    }

    expect(contexts[0]).toMatchObject({
      historyReadMessages: 1,
      historyCachedMessages: 0,
    });
    expect(contexts[1]).toMatchObject({
      historyReadMessages: 4,
      historyCachedMessages: 3,
      historyMessages: 4,
    });
  });

  it("times the claims and the reads beside them as one group, then the save", async () => {
    mockChatAI.mockResolvedValueOnce("Hello world");

    const response = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    await response.text();

    const timed = vi
      .mocked(measurePreparation)
      .mock.calls.map(([operation, promiseAllId]) => ({
        operation,
        promiseAllId,
      }));
    const preparationId = timed.find(
      ({ operation }) => operation === "claimConversationTurn",
    )?.promiseAllId;
    expect(preparationId).toEqual(expect.any(String));
    expect(
      timed
        .filter(({ promiseAllId }) => promiseAllId === preparationId)
        .map(({ operation }) => operation)
        .sort(),
    ).toEqual([
      "claimAttachments",
      "claimConversationTurn",
      "findContextHistory",
      "findTranscripts",
      "resolveImages",
    ]);
    expect(timed).toContainEqual({
      operation: "persistAndUnclaimChatTurn",
      promiseAllId: undefined,
    });
  });

  it("uses the first message as a fallback when title generation fails", async () => {
    mockChatAI.mockResolvedValueOnce("Hello world");
    mockGenerateTitle.mockRejectedValueOnce(new Error("title model failed"));

    const response = await postMessage({
      messageContent: "  Plan   the next quarter  ",
      chosenModelId: modelId,
    });
    await response.text();

    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationTitle: "Plan the next quarter",
      }),
    );
  });

  it("persists the turn even when the client disconnects mid-stream", async () => {
    const client = new AbortController();
    mockChatAI.mockImplementation(
      async (
        _model: string,
        _turns: unknown,
        opts: { onDelta: (d: string) => void | Promise<void> },
      ) => {
        await opts.onDelta("Hello ");
        client.abort(); // the user closes the tab mid-answer
        for (const chunk of ["w", "o", "r", "l", "d"])
          await opts.onDelta(chunk);
        return "Hello world";
      },
    );

    const res = await postMessage(
      { messageContent: "Hi there", chosenModelId: modelId },
      client.signal,
    );
    expect(res.status).toBe(200);
    await res.text().catch(() => {}); // the aborted stream may reject here

    // The run is decoupled from the response, so it completes and persists the
    // whole turn regardless of the disconnect. Persistence is fire-and-forget.
    await vi.waitFor(() =>
      expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          conversationId,
          content: "Hi there",
          assistantContent: "Hello world",
        }),
      ),
    );
  });

  it("replays prior history to the model, oldest first", async () => {
    mockFindContextHistory.mockResolvedValueOnce([
      // History arrives newest-first from the query; the controller reverses it.
      createMessageHistory({
        id: assistantRow.id,
        role: "assistant",
        content: "Old answer",
      }),
      createMessageHistory({
        id: messageId,
        role: "user",
        content: "Old question",
      }),
    ]);
    mockChatAI.mockResolvedValueOnce("Hello world");

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(mockChatAI).toHaveBeenCalledWith(
      modelId,
      [
        { role: "user", content: "Old question" },
        { role: "assistant", content: "Old answer" },
        { role: "user", content: "Hi there" },
      ],
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );
  });

  it("leaves out of the next history read the text this one read and saved", async () => {
    const olderId = "650e8400-e29b-41d4-a716-446655440000";
    mockFindContextHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: olderId,
        content: "Earlier",
        transcripts: [{ audioUploadId: "audio-history", content: "T" }],
      }),
    ]);
    mockChatAI.mockResolvedValueOnce("Hello world");
    mockChatAI.mockResolvedValueOnce("Second reply");

    for (const messageContent of ["Hi there", "And again"]) {
      const res = await postMessage({ messageContent, chosenModelId: modelId });
      expect(res.status).toBe(200);
      await res.text();
    }

    expect(mockFindContextHistory.mock.calls[0][0]).not.toHaveProperty(
      "knownText",
    );
    expect(mockFindContextHistory.mock.calls[1][0].knownText).toEqual({
      messages: new Map([
        [olderId, "Earlier"],
        [userRow.id, "Hi there"],
        [assistantRow.id, "Hello world"],
      ]),
      transcripts: new Map([["audio-history", "T"]]),
    });
  });

  it("replays transcript history without reading the transcripts again", async () => {
    mockFindContextHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: assistantRow.id,
        content: "Newer",
        transcripts: [{ audioUploadId: "audio-history", content: "T" }],
      }),
    ]);
    mockChatAI.mockResolvedValueOnce("Hello world");

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(mockFindTranscripts).toHaveBeenCalledOnce();
    expect(mockFindTranscripts).toHaveBeenCalledWith(userId, []);
    const [, turns] = mockChatAI.mock.calls[0];
    expect(turns).toHaveLength(2);
  });

  it("replays images a past turn was sent with", async () => {
    mockFindContextHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: messageId,
        role: "user",
        content: "What is this?",
        imageUrls: [resolvedImage.url],
      }),
    ]);
    mockChatAI.mockResolvedValueOnce("Hello world");

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(mockChatAI).toHaveBeenCalledWith(
      modelId,
      [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", imageUrl: { url: resolvedImage.url } },
          ],
        },
        // The new turn has no images of its own, so it stays a plain string.
        { role: "user", content: "Hi there" },
      ],
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );
  });

  it("rejects a text-only model when the assembled history contains an image", async () => {
    mockFindContextHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: messageId,
        role: "user",
        content: "What is this?",
        imageUrls: [resolvedImage.url],
      }),
    ]);
    mockFindChatModel.mockResolvedValue({
      id: modelId,
      name: "Text only",
      contextTokens: null,
      acceptsImages: false,
    });

    const response = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "Invalid model: must accept image input",
    });
    expect(mockChatAI).not.toHaveBeenCalled();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
  });

  it("budgets history and caps the response", async () => {
    const long = "x".repeat(Math.floor(MAX_CONTEXT_CHARS / 3));
    mockFindContextHistory.mockResolvedValueOnce([
      createMessageHistory({ role: "user", content: `newest ${long}` }),
      createMessageHistory({ role: "assistant", content: `middle ${long}` }),
    ]);
    mockChatAI.mockResolvedValueOnce("Hello world");

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(200);
    await res.text();

    const [, turns, opts] = mockChatAI.mock.calls[0];
    const labels = turns.map((t: { content: string }) => t.content.slice(0, 6));
    expect(labels).toEqual(["middle", "newest", "Hi the"]);
    expect(opts.maxOutputTokens).toBe(MAX_RESPONSE_TOKENS);
    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindowMessageCount: 4 }),
    );
  });

  describe("with transcript attachments", () => {
    const firstAudioUploadId = "950e8400-e29b-41d4-a716-446655440444";
    const secondAudioUploadId = "a50e8400-e29b-41d4-a716-446655440555";
    const firstTranscript = "the interview transcript";
    const secondTranscript = "the product demonstration transcript";

    it("sends multiple transcripts in order and records their links", async () => {
      mockFindTranscripts.mockResolvedValueOnce(
        new Map([
          [firstAudioUploadId, firstTranscript],
          [secondAudioUploadId, secondTranscript],
        ]),
      );
      mockChatAI.mockResolvedValueOnce("Hello world");

      const response = await postMessage({
        messageContent: "Compare these",
        chosenModelId: modelId,
        audioUploadIds: [firstAudioUploadId, secondAudioUploadId],
      });
      expect(response.status).toBe(200);
      await response.text();

      expect(mockChatAI).toHaveBeenCalledWith(
        modelId,
        [
          {
            role: "user",
            content: `${firstTranscript}\n\n${secondTranscript}\n\nCompare these`,
          },
        ],
        expect.objectContaining({ onDelta: expect.any(Function) }),
      );
      await vi.waitFor(() =>
        expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            content: "Compare these",
            attachmentIds: [firstAudioUploadId, secondAudioUploadId],
          }),
        ),
      );
      expect(mockFindTranscripts).toHaveBeenCalledWith(userId, [
        firstAudioUploadId,
        secondAudioUploadId,
      ]);
    });

    it("replays all transcripts from a past turn", async () => {
      mockFindContextHistory.mockResolvedValueOnce([
        createMessageHistory({
          id: messageId,
          role: "user",
          content: "Compare these",
          transcripts: [
            { audioUploadId: "audio-first", content: firstTranscript },
            { audioUploadId: "audio-second", content: secondTranscript },
          ],
        }),
      ]);
      mockChatAI.mockResolvedValueOnce("Hello world");

      const response = await postMessage({
        messageContent: "What do they have in common?",
        chosenModelId: modelId,
      });
      expect(response.status).toBe(200);
      await response.text();

      const [, turns] = mockChatAI.mock.calls[0];
      expect(turns[0].content).toContain(firstTranscript);
      expect(turns[0].content).toContain(secondTranscript);
      expect(turns[0].content.indexOf(firstTranscript)).toBeLessThan(
        turns[0].content.indexOf(secondTranscript),
      );
    });

    // A guard on the request, before the claim or any context read: the
    // budget below is what limits the prompt.
    it("rejects more transcripts than one message may carry, before any database work", async () => {
      const audioUploadIds = Array.from(
        { length: MAX_TRANSCRIPTS + 1 },
        (_, i) => `b50e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
      );

      const response = await postMessage({
        messageContent: "Compare all of these",
        chosenModelId: modelId,
        audioUploadIds,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: `Too many transcripts: at most ${MAX_TRANSCRIPTS} per message`,
      });
      expect(mockClaimConversationTurn).not.toHaveBeenCalled();
      expect(mockClaimAttachments).not.toHaveBeenCalled();
      expect(mockFindTranscripts).not.toHaveBeenCalled();
    });

    it("says how many images a message may carry", async () => {
      const response = await postMessage({
        messageContent: "Compare these",
        chosenModelId: modelId,
        imageUploadIds: Array.from(
          { length: 7 },
          (_, i) => `c50e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
        ),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "Too many images: at most 6 per message",
      });
    });

    it("counts a repeated transcript once", async () => {
      mockFindTranscripts.mockResolvedValueOnce(
        new Map([[firstAudioUploadId, firstTranscript]]),
      );

      const response = await postMessage({
        messageContent: "Summarise this",
        chosenModelId: modelId,
        audioUploadIds: Array(MAX_TRANSCRIPTS + 1).fill(firstAudioUploadId),
      });

      expect(response.status).toBe(200);
    });

    it("returns 404 when any requested transcript is unavailable", async () => {
      mockFindTranscripts.mockResolvedValueOnce(
        new Map([[firstAudioUploadId, firstTranscript]]),
      );

      const response = await postMessage({
        messageContent: "Compare these",
        chosenModelId: modelId,
        audioUploadIds: [firstAudioUploadId, secondAudioUploadId],
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        message: "Transcript not found",
      });
      expect(mockChatAI).not.toHaveBeenCalled();
      expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
      expect(mockUnclaimConversationTurn).toHaveBeenCalledTimes(1);
    });

    it("refuses combined transcript content past the context budget", async () => {
      const oversizedTranscript = "x".repeat(MAX_CONTEXT_CHARS);
      mockFindTranscripts.mockResolvedValueOnce(
        new Map([[firstAudioUploadId, oversizedTranscript]]),
      );

      const response = await postMessage({
        messageContent: "Summarise this",
        chosenModelId: modelId,
        audioUploadIds: [firstAudioUploadId],
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        message: "Message is too long for one message",
        maxChars: MAX_CONTEXT_CHARS,
        chars: expect.any(Number),
      });
      expect(mockChatAI).not.toHaveBeenCalled();
      expect(mockUnclaimConversationTurn).toHaveBeenCalledTimes(1);
    });

    it("counts every current transcript against the history budget", async () => {
      const long = "x".repeat(Math.floor(MAX_CONTEXT_CHARS / 3));
      const transcript = "y".repeat(MAX_CONTEXT_CHARS / 2);
      mockFindTranscripts.mockResolvedValueOnce(
        new Map([[firstAudioUploadId, transcript]]),
      );
      mockFindContextHistory.mockResolvedValueOnce([
        createMessageHistory({ role: "user", content: `newest ${long}` }),
      ]);
      mockChatAI.mockResolvedValueOnce("Hello world");

      const response = await postMessage({
        messageContent: "Summarise this",
        chosenModelId: modelId,
        audioUploadIds: [firstAudioUploadId],
      });
      expect(response.status).toBe(200);
      await response.text();

      const [, turns] = mockChatAI.mock.calls[0];
      expect(turns).toHaveLength(2);
      expect(turns[0].content.slice(0, 6)).toBe("newest");
      expect(mockFindContextHistory).toHaveBeenCalledWith({
        userId,
        conversationId,
        maximumMessageCount: 49,
      });
    });
  });

  it("emits an SSE error event and persists nothing when the model fails", async () => {
    mockChatAI.mockRejectedValueOnce(new Error("provider exploded"));

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");

    // The writes only run once a reply is known, so a failed turn saves nothing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
    expect(mockUnclaimAttachments).toHaveBeenCalledWith(requestClaimToken());
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
      userId,
      conversationId,
      requestClaimToken(),
    );
  });

  it("sends attachments as vision input and links them to the user turn", async () => {
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockChatAI.mockResolvedValueOnce("Hello world");

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });
    expect(res.status).toBe(200);
    await res.text();

    // The turn the model sees carries the text and the signed image url.
    expect(mockChatAI).toHaveBeenCalledWith(
      modelId,
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Hi there" },
            { type: "image_url", imageUrl: { url: resolvedImage.url } },
          ],
        },
      ],
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );
    // The upload rides along on the turn's transactional write, to be claimed
    // by the user message it inserts.
    await vi.waitFor(() =>
      expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentIds: [imageUploadId] }),
      ),
    );
  });

  it("rejects an image that is missing or belongs to another user", async () => {
    mockResolveImages.mockResolvedValueOnce([]);

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Image not found" });
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledTimes(1);
  });

  it("releases once and returns the first of multiple validation errors", async () => {
    const audioUploadId = "950e8400-e29b-41d4-a716-446655440444";
    mockResolveImages.mockResolvedValueOnce([]);
    mockFindTranscripts.mockResolvedValueOnce(
      new Map([[audioUploadId, "x".repeat(MAX_CONTEXT_CHARS + 1)]]),
    );

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
      audioUploadIds: [audioUploadId],
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Image not found" });
    expect(mockUnclaimConversationTurn).toHaveBeenCalledTimes(1);
    expect(mockChatAI).not.toHaveBeenCalled();
  });

  it("rejects attachments on a model that can't read images with 400", async () => {
    mockFindChatModel.mockResolvedValue({
      id: modelId,
      name: "Text only",
      contextTokens: null,
      acceptsImages: false,
    });

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    expect(res.status).toBe(400);
    expect(mockFindOwnedConversation).not.toHaveBeenCalled();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation is not owned by the user", async () => {
    mockClaimConversationTurn.mockResolvedValueOnce(null);
    mockFindOwnedConversation.mockResolvedValueOnce(null);
    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(404);
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
  });

  it("rejects an invalid model with 400 before touching the db", async () => {
    // Model validation runs in the body-schema middleware, ahead of the
    // handler's ownership check.
    mockFindChatModel.mockResolvedValueOnce(undefined);
    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: "nope",
    });
    expect(res.status).toBe(400);
    expect(mockFindOwnedConversation).not.toHaveBeenCalled();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
  });

  it("rejects an empty message with 400", async () => {
    const res = await postMessage({
      messageContent: "   ",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(400);
    expect(mockFindOwnedConversation).not.toHaveBeenCalled();
  });
});

describe("PATCH /conversations/:conversationId/messages/:messageId", () => {
  const audioUploadId = "950e8400-e29b-41d4-a716-446655440444";

  function patchMessage(body: unknown) {
    return sessionCookieHeader(userId).then(async (cookie) =>
      (await createApp()).request(
        `http://localhost/conversations/${conversationId}/messages/${messageId}`,
        {
          method: "PATCH",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify(messageRequestBody(body)),
        },
      ),
    );
  }

  const edit = {
    messageContent: "Updated question",
    chosenModelId: modelId,
    imageUploadIds: [] as string[],
    audioUploadIds: [] as string[],
    lastMessageId: assistantRow.id,
  };

  it("validates, rewinds under its own claim, and streams a new turn", async () => {
    mockFindContextHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: assistantRow.id,
        role: "assistant",
        content: "Earlier answer",
      }),
      createMessageHistory({
        id: "450e8400-e29b-41d4-a716-446655440999",
        role: "user",
        content: "Earlier question",
      }),
    ]);
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockFindTranscripts.mockResolvedValueOnce(
      new Map([[audioUploadId, "Edited transcript"]]),
    );
    mockDeleteOwnedMessage.mockResolvedValueOnce({
      status: "deleted",
      ids: [messageId],
      imageUploadIds: ["old-image"],
      lastMessageId: null,
    });
    mockChatAI.mockImplementationOnce(
      async (
        _model: string,
        _turns: unknown,
        options: { onDelta: (delta: string) => void | Promise<void> },
      ) => {
        await options.onDelta("Replacement answer");
        return "Replacement answer";
      },
    );

    const response = await patchMessage({
      ...edit,
      imageUploadIds: [imageUploadId],
      audioUploadIds: [audioUploadId],
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("event: delta");
    const { lastMessageId, stopped, stats } = doneOf(body);
    expect({ lastMessageId, stopped }).toEqual({
      lastMessageId: assistantRow.id,
      stopped: false,
    });
    // The rewind is timed with the rest, between the reads and the save.
    expect(stats?.steps.map((step) => step.operation)).toEqual(
      expect.arrayContaining(["findContextHistory", "rewindTo"]),
    );
    expect(stats?.context).toMatchObject({
      historyMessages: 2,
      newTurnChars: "Edited transcript\n\nUpdated question".length,
    });

    // The history stops before the edited message.
    expect(mockFindContextHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        conversationId,
        beforeMessageId: messageId,
      }),
    );
    // One claim serves the whole request, the rewind included.
    const claimToken = mockClaimConversationTurn.mock.calls[0][3];
    expect(mockClaimConversationTurn).toHaveBeenCalledWith(
      userId,
      conversationId,
      assistantRow.id,
      expect.any(String),
    );
    expect(mockDeleteOwnedMessage).toHaveBeenCalledWith(
      userId,
      conversationId,
      messageId,
      { claimToken, onlyRole: "user" },
    );
    expect(mockDeleteObjects).toHaveBeenCalledWith(userId, [
      { kind: "image", uploadId: "old-image" },
    ]);
    expect(mockChatAI).toHaveBeenCalledWith(
      modelId,
      [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "Edited transcript\n\nUpdated question" },
            { type: "image_url", imageUrl: { url: resolvedImage.url } },
          ],
        },
      ],
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );
    // The replacement is stored like any other turn.
    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        conversationId,
        content: "Updated question",
        attachmentIds: [imageUploadId, audioUploadId],
        assistantContent: "Replacement answer",
        claimToken,
      }),
    );
    // Validated first, rewound second, only then the model.
    expect(mockFindContextHistory.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteOwnedMessage.mock.invocationCallOrder[0],
    );
    expect(mockDeleteOwnedMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockChatAI.mock.invocationCallOrder[0],
    );
  });

  it("reserves the edit's attachments, as a new message does", async () => {
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);

    const response = await patchMessage({
      ...edit,
      imageUploadIds: [imageUploadId],
    });
    await response.text();

    const claimToken = mockClaimConversationTurn.mock.calls[0][3];
    expect(mockClaimAttachments).toHaveBeenCalledWith(
      userId,
      [imageUploadId],
      claimToken,
    );
    // Saving the edit releases the reservations with it.
    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken }),
    );
    expect(mockUnclaimAttachments).not.toHaveBeenCalled();
  });

  it("keeps the rewind and releases its claim when generation fails", async () => {
    mockChatAI.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await patchMessage(edit);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: error");
    expect(mockDeleteOwnedMessage).toHaveBeenCalledOnce();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
      userId,
      conversationId,
      mockClaimConversationTurn.mock.calls[0][3],
    );
  });

  it("rejects assistant-message edits, and releases the claim", async () => {
    mockDeleteOwnedMessage.mockResolvedValueOnce({ status: "wrong_role" });

    const response = await patchMessage(edit);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "Only user messages can be edited",
    });
    expect(mockChatAI).not.toHaveBeenCalled();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledOnce();
  });

  it("returns 404 and releases the claim when the message is unavailable", async () => {
    mockDeleteOwnedMessage.mockResolvedValueOnce(null);

    const response = await patchMessage(edit);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Message not found" });
    expect(mockChatAI).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledOnce();
  });

  it("returns 409 when the submitted conversation head is stale", async () => {
    mockClaimConversationTurn.mockResolvedValueOnce(null);

    const response = await patchMessage({ ...edit, lastMessageId: messageId });

    expect(response.status).toBe(409);
    expect(mockDeleteOwnedMessage).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation is unavailable", async () => {
    mockClaimConversationTurn.mockResolvedValueOnce(null);
    mockFindOwnedConversation.mockResolvedValueOnce(null);

    const response = await patchMessage(edit);

    expect(response.status).toBe(404);
    expect(mockDeleteOwnedMessage).not.toHaveBeenCalled();
  });

  it("does not rewind when an image is unavailable", async () => {
    mockResolveImages.mockResolvedValueOnce([]);

    const response = await patchMessage({
      ...edit,
      imageUploadIds: [imageUploadId],
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Image not found" });
    expect(mockDeleteOwnedMessage).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledOnce();
  });

  it("does not rewind when an attachment can't be reserved", async () => {
    mockClaimAttachments.mockResolvedValueOnce(false);

    const response = await patchMessage(edit);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Attachment not found" });
    expect(mockDeleteOwnedMessage).not.toHaveBeenCalled();
  });

  it("does not rewind when retained history needs image input", async () => {
    mockFindContextHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: messageId,
        role: "user",
        content: "What is this?",
        imageUrls: [resolvedImage.url],
      }),
    ]);
    mockFindChatModel.mockResolvedValue({
      id: modelId,
      name: "Text only",
      contextTokens: null,
      acceptsImages: false,
    });

    const response = await patchMessage(edit);

    expect(response.status).toBe(400);
    expect(mockDeleteOwnedMessage).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledOnce();
  });

  it("does not rewind when the edited turn exceeds the context budget", async () => {
    mockFindTranscripts.mockResolvedValueOnce(
      new Map([[audioUploadId, "x".repeat(MAX_CONTEXT_CHARS)]]),
    );

    const response = await patchMessage({
      ...edit,
      audioUploadIds: [audioUploadId],
    });

    expect(response.status).toBe(413);
    expect(mockDeleteOwnedMessage).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledOnce();
  });
});

describe("stopping a reply", () => {
  async function request(path: string, init: RequestInit = {}) {
    return (await createApp()).request(
      `http://localhost/conversations/${conversationId}/messages${path}`,
      {
        ...init,
        headers: {
          ...(await authedHeaders(userId)),
          "Content-Type": "application/json",
        },
      },
    );
  }

  function sendTurn() {
    return request("", {
      method: "POST",
      body: JSON.stringify(
        messageRequestBody({
          messageContent: "Hi there",
          chosenModelId: modelId,
          lastMessageId: null,
        }),
      ),
    });
  }

  const stopReply = () => request("/stop", { method: "POST" });

  /**
   * A model call that sends `deltas`, then runs `whileWaiting` and waits to be
   * stopped, as the real one would keep writing until it is.
   */
  function modelThatWaits(
    deltas: string[],
    whileWaiting: () => Promise<unknown> = stopReply,
  ) {
    mockChatAI.mockImplementation(
      async (
        _model: string,
        _turns: unknown,
        opts: {
          onDelta: (d: string) => Promise<void>;
          signal: AbortSignal;
        },
      ) => {
        for (const delta of deltas) await opts.onDelta(delta);
        await whileWaiting();
        await new Promise((_, reject) => {
          const fail = () => reject(opts.signal.reason as Error);
          if (opts.signal.aborted) fail();
          opts.signal.addEventListener("abort", fail);
        });
      },
    );
  }

  it("saves what came before the stop, marked as stopped", async () => {
    modelThatWaits(["Hello "]);

    const body = await (await sendTurn()).text();

    expect(doneOf(body)).toMatchObject({
      lastMessageId: assistantRow.id,
      stopped: true,
    });
    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Hi there",
        assistantContent: "Hello ",
        stopped: true,
      }),
    );
  });

  it("saves nothing, and lets go of the turn, when stopped before any reply", async () => {
    modelThatWaits([]);

    const body = await (await sendTurn()).text();

    expect(body).toContain("event: cancelled");
    expect(body).not.toContain("event: done");
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
      userId,
      conversationId,
      mockClaimConversationTurn.mock.calls[0][3],
    );
  });

  it("shows a reloaded page the turn being answered, and stops showing it once saved", async () => {
    mockFindConversationMessages.mockResolvedValue([]);
    const sendEvent = vi.spyOn(eventHub, "send");
    let whileWriting: unknown;
    modelThatWaits(["Hello "], async () => {
      whileWriting = await (await request("")).json();
      await stopReply();
    });

    await (await sendTurn()).text();

    expect(whileWriting).toMatchObject({
      replyInProgress: { content: "Hi there", assistantContent: "Hello " },
    });
    expect(await (await request("")).json()).toMatchObject({
      replyInProgress: null,
    });
    expect(sendEvent).toHaveBeenCalledWith(userId, "replyFinished", {
      conversationId,
    });
  });

  it("says there's nothing to stop when no reply is being written", async () => {
    const res = await stopReply();

    expect(res.status).toBe(404);
  });

  it("doesn't reach another user's reply", async () => {
    modelThatWaits(["Hello "], async () => {
      const otherUser = await (
        await createApp()
      ).request(
        `http://localhost/conversations/${conversationId}/messages/stop`,
        { method: "POST", headers: await authedHeaders("user_01OTHER") },
      );
      expect(otherUser.status).toBe(404);
      await stopReply();
    });

    await (await sendTurn()).text();
  });
});

describe("DELETE /conversations/:conversationId/messages/:messageId", () => {
  it("deletes the message", async () => {
    mockDeleteOwnedMessage.mockResolvedValueOnce({
      status: "deleted",
      ids: [messageId],
      imageUploadIds: [],
      lastMessageId: null,
    });
    const res = await (
      await createApp()
    ).request(
      `http://localhost/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: await authedHeaders(userId),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Message deleted" });
  });

  it("removes the message's images from the bucket", async () => {
    mockDeleteOwnedMessage.mockResolvedValueOnce({
      status: "deleted",
      ids: [messageId, assistantRow.id],
      imageUploadIds: [imageUploadId, "another-upload"],
      lastMessageId: null,
    });

    const res = await (
      await createApp()
    ).request(
      `http://localhost/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: await authedHeaders(userId),
      },
    );

    expect(res.status).toBe(200);
    expect(mockDeleteObjects).toHaveBeenCalledWith(userId, [
      { kind: "image", uploadId: imageUploadId },
      { kind: "image", uploadId: "another-upload" },
    ]);
  });

  it("returns 404 when the message does not exist for the user", async () => {
    mockDeleteOwnedMessage.mockResolvedValueOnce(null);
    const res = await (
      await createApp()
    ).request(
      `http://localhost/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: await authedHeaders(userId),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 without deleting files while a response is active", async () => {
    mockDeleteOwnedMessage.mockResolvedValueOnce({ status: "active" });

    const res = await (
      await createApp()
    ).request(
      `http://localhost/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: await authedHeaders(userId),
      },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      message: "A response is already in progress",
    });
    expect(mockDeleteObjects).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid message id with 400", async () => {
    const res = await (
      await createApp()
    ).request(
      `http://localhost/conversations/${conversationId}/messages/not-a-uuid`,
      {
        method: "DELETE",
        headers: await authedHeaders(userId),
      },
    );
    expect(res.status).toBe(400);
    expect(mockDeleteOwnedMessage).not.toHaveBeenCalled();
  });
});
