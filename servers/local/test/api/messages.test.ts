import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFindConversation,
  mockClaimConversationTurn,
  mockUnclaimConversationTurn,
  mockFindCreateMessageHistory,
  mockPersistAndUnclaimChatTurn,
  mockFindConversationMessages,
  mockDeleteMessage,
  mockResolveImages,
  mockResolveMessageImages,
  mockResolveImageAttachmentUrls,
  mockFindMessageTranscriptAttachments,
  mockFindTranscripts,
  mockDeleteFiles,
  mockFindChatModel,
  mockChatAI,
  mockGenerateTitle,
  mockClaimAttachments,
  mockUnclaimAttachments,
} = vi.hoisted(() => ({
  mockFindConversation: vi.fn(),
  mockClaimConversationTurn: vi.fn(),
  mockUnclaimConversationTurn: vi.fn(),
  mockFindCreateMessageHistory: vi.fn(),
  mockPersistAndUnclaimChatTurn: vi.fn(),
  mockFindConversationMessages: vi.fn(),
  mockDeleteMessage: vi.fn(),
  mockResolveImages: vi.fn(),
  mockResolveMessageImages: vi.fn(),
  mockResolveImageAttachmentUrls: vi.fn(),
  mockFindMessageTranscriptAttachments: vi.fn(),
  mockFindTranscripts: vi.fn(),
  mockDeleteFiles: vi.fn(),
  mockFindChatModel: vi.fn(),
  mockChatAI: vi.fn(),
  mockGenerateTitle: vi.fn(),
  mockClaimAttachments: vi.fn(),
  mockUnclaimAttachments: vi.fn(),
}));

vi.mock("../../core/data/attachments.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/data/attachments.data")>();
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
vi.mock("../../core/db", async () => ({
  db: {},
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

vi.mock("../../core/data/conversations.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/data/conversations.data")>();
  return {
    ...actual,
    conversations: {
      ...actual.conversations,
      findConversation: mockFindConversation,
      claimConversationTurn: mockClaimConversationTurn,
      unclaimConversationTurn: mockUnclaimConversationTurn,
    },
  };
});

vi.mock("../../core/data/messages.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/data/messages.data")>();
  return {
    ...actual,
    messages: {
      ...actual.messages,
      findCreateMessageHistory: mockFindCreateMessageHistory,
      persistAndUnclaimChatTurn: mockPersistAndUnclaimChatTurn,
      findConversationMessages: mockFindConversationMessages,
      deleteMessage: mockDeleteMessage,
    },
  };
});

vi.mock("../../core/data/images.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/data/images.data")>();
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

vi.mock("../../core/data/transcripts.data", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/data/transcripts.data")>();
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
vi.mock("../../core/files", async (importActual) => {
  const actual = await importActual<typeof import("../../core/files")>();
  return { ...actual, files: { ...actual.files, delete: mockDeleteFiles } };
});

// buildUserTurn is the real one: what the model is handed for an image turn is
// exactly what these tests are checking.
vi.mock("../../core/ai/ai_chat_client", async (importActual) => {
  const actual =
    await importActual<typeof import("../../core/ai/ai_chat_client")>();
  return {
    ...actual,
    findChatModel: mockFindChatModel,
    // The image's file isn't there to read; what matters is where its input goes.
    chatImageInput: async () => IMAGE_INPUT,
    chatAI: mockChatAI,
    generateTitle: mockGenerateTitle,
  };
});

import { createApp } from "../../api/app";
import { eventHub } from "../../api/src/sse/hub";
import { MAX_CONTEXT_CHARS } from "../../api/src/controllers/messages.controller";
import { MAX_TRANSCRIPTS } from "../../api/src/schema/messages.schema";
import { originHeaders } from "../helpers/headers";
import { type CreateMessageHistory } from "../../core/data/messages.data";

const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const messageId = "650e8400-e29b-41d4-a716-446655440111";
const modelId = "sonnet";
const createdAt = "2026-07-22T00:00:00.000Z";

const imageUploadId = "850e8400-e29b-41d4-a716-446655440333";

const conversation = {
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

/** A message as the database hands it over, where the JSON has a string. */
function rowOf<Message extends { createdAt: string }>(message: Message) {
  return { ...message, createdAt: new Date(message.createdAt) };
}

const resolvedImage = {
  imageUploadId,
  fileName: "diagram.png",
  mimeType: "image/png",
  size: 1234,
  url: `/upload/image/${imageUploadId}`,
};

/** What the model is handed for the image, inline. */
const IMAGE_INPUT = { mimeType: "image/png", data: "cGl4ZWxz" };

/** The image as history carries it. */
const historyImage = { imageUploadId, mimeType: "image/png" };

/** A history turn as findRecentMessagesWithContext hands it back, newest first. */
function createMessageHistory(
  partial: Partial<CreateMessageHistory> = {},
): CreateMessageHistory {
  const content = partial.content ?? "";
  const transcriptContents = partial.transcriptContents ?? [];
  return {
    id: messageId,
    role: "user",
    createdAt: new Date(createdAt),
    images: [],
    ...partial,
    content,
    transcriptContents,
    contextCharCount:
      partial.contextCharCount ??
      content.length +
        transcriptContents.reduce(
          (total, transcript) => total + transcript.length,
          0,
        ) +
        transcriptContents.length * 2,
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
  mockFindConversation.mockResolvedValue(conversation);
  mockClaimConversationTurn.mockImplementation(
    (_conversationId, _lastMessageId, claimToken = "claim-token") =>
      Promise.resolve(claimToken),
  );
  mockUnclaimConversationTurn.mockResolvedValue(undefined);
  mockClaimAttachments.mockResolvedValue(true);
  mockUnclaimAttachments.mockResolvedValue(undefined);
  mockFindCreateMessageHistory.mockResolvedValue([]);
  mockResolveImages.mockResolvedValue([]);
  mockResolveMessageImages.mockResolvedValue(new Map());
  mockResolveImageAttachmentUrls.mockResolvedValue(new Map());
  mockFindMessageTranscriptAttachments.mockResolvedValue(new Map());
  mockFindTranscripts.mockResolvedValue(new Map());
  mockPersistAndUnclaimChatTurn.mockResolvedValue(assistantRow.id);
  mockDeleteMessage.mockResolvedValue({
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
  mockDeleteFiles.mockResolvedValue([]);
});

describe("GET /conversations/:conversationId/messages", () => {
  it("lists the conversation's messages oldest-first", async () => {
    mockFindConversationMessages.mockResolvedValueOnce([
      rowOf(userRow),
      rowOf(assistantRow),
    ]);
    const res = await (
      await createApp()
    ).request(`http://localhost/conversations/${conversationId}/messages`, {
      headers: originHeaders(),
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
    const url = `http://localhost/conversations/${conversationId}/messages`;

    const first = await app.request(url);
    const etag = first.headers.get("ETag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const second = await app.request(url, {
      headers: { "If-None-Match": etag as string },
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
      headers: originHeaders(),
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

  it("returns 404 when the conversation does not exist", async () => {
    mockFindConversation.mockResolvedValueOnce(null);
    const res = await (
      await createApp()
    ).request(`http://localhost/conversations/${conversationId}/messages`, {
      headers: originHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /conversations/:conversationId/messages", () => {
  function requestClaimToken(): string {
    return mockClaimConversationTurn.mock.calls[0][2];
  }

  async function postMessage(body: unknown, signal?: AbortSignal) {
    const requestBody =
      body && typeof body === "object" && !Array.isArray(body)
        ? messageRequestBody({ lastMessageId: null, ...body })
        : body;
    return (await createApp()).request(
      `http://localhost/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
      },
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
    const history = Promise.withResolvers<CreateMessageHistory[]>();
    mockFindCreateMessageHistory.mockReturnValueOnce(history.promise);
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockChatAI.mockResolvedValueOnce("Description");

    const responsePromise = postMessage({
      messageContent: "Describe this",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    await vi.waitFor(() =>
      expect(mockClaimAttachments).toHaveBeenCalledWith(
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
    mockFindCreateMessageHistory.mockRejectedValueOnce(
      new Error("history unavailable"),
    );

    const responsePromise = postMessage({
      messageContent: "Describe this",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });

    await vi.waitFor(() =>
      expect(mockFindCreateMessageHistory).toHaveBeenCalled(),
    );
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
      [audioUploadId],
      requestClaimToken(),
    );
    expect(mockUnclaimAttachments).toHaveBeenCalledExactlyOnceWith(
      requestClaimToken(),
    );
    expect(mockUnclaimConversationTurn).toHaveBeenCalledExactlyOnceWith(
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
    const persistence = Promise.withResolvers<string>();
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
    persistence.resolve(assistantRow.id);

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
        [],
        requestClaimToken(),
      );
      expect(mockResolveImages).toHaveBeenCalled();
      expect(mockFindCreateMessageHistory).toHaveBeenCalled();
    });

    resolveClaim(requestClaimToken());
    const res = await responsePromise;
    expect(res.status).toBe(200);
    await res.text();
  });

  it("releases an acquired claim when a context read fails", async () => {
    mockFindCreateMessageHistory.mockRejectedValueOnce(
      new Error("history unavailable"),
    );

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });

    expect(res.status).toBe(500);
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
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
    expect(mockClaimAttachments).toHaveBeenCalledWith([], requestClaimToken());
    expect(mockUnclaimAttachments).toHaveBeenCalledExactlyOnceWith(
      requestClaimToken(),
    );
    expect(mockUnclaimConversationTurn).toHaveBeenCalledExactlyOnceWith(
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
    expect(body).toContain("event: done");
    expect(body).toContain(
      JSON.stringify({ lastMessageId: assistantRow.id, stopped: false }),
    );
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
    expect(mockGenerateTitle).toHaveBeenCalledWith("conversation", "Hi there");
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
          conversationId,
          content: "Hi there",
          assistantContent: "Hello world",
        }),
      ),
    );
  });

  it("replays prior history to the model, oldest first", async () => {
    mockFindCreateMessageHistory.mockResolvedValueOnce([
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

  it("uses transcript history admitted by the data layer", async () => {
    mockFindCreateMessageHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: assistantRow.id,
        content: "Newer",
        transcriptContents: ["T"],
        contextCharCount: 15,
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
    expect(mockFindTranscripts).toHaveBeenCalledWith([]);
    const [, turns] = mockChatAI.mock.calls[0];
    expect(turns).toHaveLength(2);
  });

  it("replays images a past turn was sent with", async () => {
    mockFindCreateMessageHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: messageId,
        role: "user",
        content: "What is this?",
        images: [historyImage],
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
            { type: "image", ...IMAGE_INPUT },
          ],
        },
        // The new turn has no images of its own, so it stays a plain string.
        { role: "user", content: "Hi there" },
      ],
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );
  });

  it("rejects a text-only model when the assembled history contains an image", async () => {
    mockFindCreateMessageHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: messageId,
        role: "user",
        content: "What is this?",
        images: [historyImage],
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
      conversationId,
      requestClaimToken(),
    );
  });

  it("uses budgeted history from the data layer and caps the response", async () => {
    const long = "x".repeat(Math.floor(MAX_CONTEXT_CHARS / 3));
    mockFindCreateMessageHistory.mockResolvedValueOnce([
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

    const [, turns] = mockChatAI.mock.calls[0];
    const labels = turns.map((t: { content: string }) => t.content.slice(0, 6));
    expect(labels).toEqual(["middle", "newest", "Hi the"]);
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
      expect(mockFindTranscripts).toHaveBeenCalledWith([
        firstAudioUploadId,
        secondAudioUploadId,
      ]);
    });

    it("replays all transcripts from a past turn", async () => {
      mockFindCreateMessageHistory.mockResolvedValueOnce([
        createMessageHistory({
          id: messageId,
          role: "user",
          content: "Compare these",
          transcriptContents: [firstTranscript, secondTranscript],
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

    it("passes every current transcript to history admission", async () => {
      const long = "x".repeat(Math.floor(MAX_CONTEXT_CHARS / 3));
      const transcript = "y".repeat(MAX_CONTEXT_CHARS / 2);
      mockFindTranscripts.mockResolvedValueOnce(
        new Map([[firstAudioUploadId, transcript]]),
      );
      mockFindCreateMessageHistory.mockResolvedValueOnce([
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
      expect(mockFindCreateMessageHistory).toHaveBeenCalledWith({
        conversationId,
        newMessageContentCharCount: "Summarise this".length,
        newTranscriptUploadIds: [firstAudioUploadId],
        transcriptSeparatorCharCount: 2,
        maximumContextCharCount: MAX_CONTEXT_CHARS,
        maximumMessageCount: 49,
        maximumImageCount: 8,
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
      conversationId,
      requestClaimToken(),
    );
  });

  it("leaves history the image cap less the new turn's images", async () => {
    mockResolveImages.mockResolvedValueOnce([resolvedImage]);
    mockChatAI.mockResolvedValueOnce("Hello world");

    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
      imageUploadIds: [imageUploadId],
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(mockFindCreateMessageHistory).toHaveBeenCalledWith(
      expect.objectContaining({ maximumImageCount: 7 }),
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

    // The turn the model sees carries the text and the image, inline.
    expect(mockChatAI).toHaveBeenCalledWith(
      modelId,
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Hi there" },
            { type: "image", ...IMAGE_INPUT },
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

  it("rejects an image that is missing", async () => {
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
    expect(mockFindConversation).not.toHaveBeenCalled();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation does not exist", async () => {
    mockClaimConversationTurn.mockResolvedValueOnce(null);
    mockFindConversation.mockResolvedValueOnce(null);
    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(404);
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
  });

  it("rejects an invalid model with 400 before touching the db", async () => {
    // Model validation runs in the body-schema middleware, ahead of the
    // handler's conversation lookup.
    mockFindChatModel.mockResolvedValueOnce(undefined);
    const res = await postMessage({
      messageContent: "Hi there",
      chosenModelId: "nope",
    });
    expect(res.status).toBe(400);
    expect(mockFindConversation).not.toHaveBeenCalled();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
  });

  it("rejects an empty message with 400", async () => {
    const res = await postMessage({
      messageContent: "   ",
      chosenModelId: modelId,
    });
    expect(res.status).toBe(400);
    expect(mockFindConversation).not.toHaveBeenCalled();
  });
});

describe("PATCH /conversations/:conversationId/messages/:messageId", () => {
  const audioUploadId = "950e8400-e29b-41d4-a716-446655440444";

  async function patchMessage(body: unknown) {
    return (await createApp()).request(
      `http://localhost/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messageRequestBody(body)),
      },
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
    mockFindCreateMessageHistory.mockResolvedValueOnce([
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
    mockDeleteMessage.mockResolvedValueOnce({
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
    expect(body).toContain(
      JSON.stringify({ lastMessageId: assistantRow.id, stopped: false }),
    );

    // The history stops before the edited message.
    expect(mockFindCreateMessageHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        beforeMessageId: messageId,
      }),
    );
    // One claim serves the whole request, the rewind included.
    const claimToken = mockClaimConversationTurn.mock.calls[0][2];
    expect(mockClaimConversationTurn).toHaveBeenCalledWith(
      conversationId,
      assistantRow.id,
      expect.any(String),
    );
    expect(mockDeleteMessage).toHaveBeenCalledWith(conversationId, messageId, {
      claimToken,
      onlyRole: "user",
    });
    expect(mockDeleteFiles).toHaveBeenCalledWith([
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
            { type: "image", ...IMAGE_INPUT },
          ],
        },
      ],
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );
    // The replacement is stored like any other turn.
    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        content: "Updated question",
        attachmentIds: [imageUploadId, audioUploadId],
        assistantContent: "Replacement answer",
        claimToken,
      }),
    );
    // Validated first, rewound second, only then the model.
    expect(
      mockFindCreateMessageHistory.mock.invocationCallOrder[0],
    ).toBeLessThan(mockDeleteMessage.mock.invocationCallOrder[0]);
    expect(mockDeleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
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

    const claimToken = mockClaimConversationTurn.mock.calls[0][2];
    expect(mockClaimAttachments).toHaveBeenCalledWith(
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
    expect(mockDeleteMessage).toHaveBeenCalledOnce();
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
      conversationId,
      mockClaimConversationTurn.mock.calls[0][2],
    );
  });

  it("rejects assistant-message edits, and releases the claim", async () => {
    mockDeleteMessage.mockResolvedValueOnce({ status: "wrong_role" });

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
    mockDeleteMessage.mockResolvedValueOnce(null);

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
    expect(mockDeleteMessage).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation is unavailable", async () => {
    mockClaimConversationTurn.mockResolvedValueOnce(null);
    mockFindConversation.mockResolvedValueOnce(null);

    const response = await patchMessage(edit);

    expect(response.status).toBe(404);
    expect(mockDeleteMessage).not.toHaveBeenCalled();
  });

  it("does not rewind when an image is unavailable", async () => {
    mockResolveImages.mockResolvedValueOnce([]);

    const response = await patchMessage({
      ...edit,
      imageUploadIds: [imageUploadId],
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Image not found" });
    expect(mockDeleteMessage).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledOnce();
  });

  it("does not rewind when an attachment can't be reserved", async () => {
    mockClaimAttachments.mockResolvedValueOnce(false);

    const response = await patchMessage(edit);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Attachment not found" });
    expect(mockDeleteMessage).not.toHaveBeenCalled();
  });

  it("does not rewind when retained history needs image input", async () => {
    mockFindCreateMessageHistory.mockResolvedValueOnce([
      createMessageHistory({
        id: messageId,
        role: "user",
        content: "What is this?",
        images: [historyImage],
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
    expect(mockDeleteMessage).not.toHaveBeenCalled();
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
    expect(mockDeleteMessage).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledOnce();
  });
});

describe("stopping a reply", () => {
  async function request(path: string, init: RequestInit = {}) {
    return (await createApp()).request(
      `http://localhost/conversations/${conversationId}/messages${path}`,
      {
        ...init,
        headers: { ...originHeaders(), "Content-Type": "application/json" },
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

    expect(body).toContain(
      JSON.stringify({ lastMessageId: assistantRow.id, stopped: true }),
    );
    expect(mockPersistAndUnclaimChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ assistantContent: "Hello ", stopped: true }),
    );
  });

  it("saves nothing, and lets go of the turn, when stopped before any reply", async () => {
    modelThatWaits([]);

    const body = await (await sendTurn()).text();

    expect(body).toContain("event: cancelled");
    expect(body).not.toContain("event: done");
    expect(mockPersistAndUnclaimChatTurn).not.toHaveBeenCalled();
    expect(mockUnclaimConversationTurn).toHaveBeenCalledWith(
      conversationId,
      mockClaimConversationTurn.mock.calls[0][2],
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
    expect(sendEvent).toHaveBeenCalledWith("everyone", "replyFinished", {
      conversationId,
    });
  });

  it("says there's nothing to stop when no reply is being written", async () => {
    expect((await stopReply()).status).toBe(404);
  });
});

describe("DELETE /conversations/:conversationId/messages/:messageId", () => {
  it("deletes the message", async () => {
    mockDeleteMessage.mockResolvedValueOnce({
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
        headers: originHeaders(),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Message deleted" });
  });

  it("removes the message's images from the bucket", async () => {
    mockDeleteMessage.mockResolvedValueOnce({
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
        headers: originHeaders(),
      },
    );

    expect(res.status).toBe(200);
    expect(mockDeleteFiles).toHaveBeenCalledWith([
      { kind: "image", uploadId: imageUploadId },
      { kind: "image", uploadId: "another-upload" },
    ]);
  });

  it("returns 404 when the message does not exist", async () => {
    mockDeleteMessage.mockResolvedValueOnce(null);
    const res = await (
      await createApp()
    ).request(
      `http://localhost/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: originHeaders(),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 without deleting files while a response is active", async () => {
    mockDeleteMessage.mockResolvedValueOnce({ status: "active" });

    const res = await (
      await createApp()
    ).request(
      `http://localhost/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: originHeaders(),
      },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      message: "A response is already in progress",
    });
    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid message id with 400", async () => {
    const res = await (
      await createApp()
    ).request(
      `http://localhost/conversations/${conversationId}/messages/not-a-uuid`,
      {
        method: "DELETE",
        headers: originHeaders(),
      },
    );
    expect(res.status).toBe(400);
    expect(mockDeleteMessage).not.toHaveBeenCalled();
  });
});
