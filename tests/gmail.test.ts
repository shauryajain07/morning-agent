import { describe, expect, it, vi } from "vitest";

import {
  collectGmailEmailItemsFromApi,
  extractGmailEmailItems,
  type GmailMessageSnapshot,
} from "../src/collectors/gmail.js";

const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

describe("Gmail API collector", () => {
  const now = new Date("2026-09-19T08:00:00+08:00");

  it("decodes a read-only Gmail payload and applies the exact lookback window", () => {
    const messages: GmailMessageSnapshot[] = [
      {
        id: "recent-message",
        threadId: "thread-1",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.parse("2026-09-18T23:40:00.000Z")),
        snippet: "Fallback snippet",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "From", value: "HKU Engineering <engineering@example.hku.hk>" },
            { name: "Subject", value: "Assignment deadline update" },
          ],
          parts: [
            {
              mimeType: "text/plain",
              body: { data: encode("The submission deadline moved to Monday evening.") },
            },
          ],
        },
      },
      {
        id: "old-message",
        internalDate: String(Date.parse("2026-09-17T23:59:00.000Z")),
        payload: {
          headers: [{ name: "Subject", value: "Old message" }],
          body: { data: encode("This should be excluded.") },
        },
      },
    ];

    const result = extractGmailEmailItems(messages, now);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Assignment deadline update",
      content: "The submission deadline moved to Monday evening.",
      metadata: {
        provider: "gmail",
        sender: "HKU Engineering",
        senderEmail: "engineering@example.hku.hk",
        unread: true,
        threadId: "thread-1",
      },
    });
    expect(result[0]?.id).toMatch(/^gmail:[a-f0-9]{24}$/u);
    expect(result[0]?.createdAt?.toISOString()).toBe("2026-09-18T23:40:00.000Z");
  });

  it("uses HTML body text and does not duplicate the same Gmail message", () => {
    const message: GmailMessageSnapshot = {
      id: "html-message",
      internalDate: String(Date.parse("2026-09-19T00:00:00.000Z")),
      payload: {
        headers: [{ name: "From", value: "Updates <updates@example.com>" }],
        parts: [
          {
            mimeType: "text/html",
            body: { data: encode("<p>Review&nbsp;<strong>this</strong> today.</p>") },
          },
        ],
      },
    };

    const result = extractGmailEmailItems([message, message], now);

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("Review this today.");
    expect(result[0]?.metadata.senderEmail).toBe("updates@example.com");
  });

  it("uses the Gmail list/get REST endpoints without mutating the mailbox", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        if (url.includes("/messages?")) {
          return new Response(JSON.stringify({ messages: [{ id: "api-message" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            id: "api-message",
            internalDate: String(Date.parse("2026-09-18T23:55:00.000Z")),
            payload: {
              headers: [{ name: "Subject", value: "API message" }],
              body: { data: encode("Read-only API body") },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );

    try {
      const result = await collectGmailEmailItemsFromApi(
        { accessToken: "access-token", maxMessages: 1, query: "newer_than:1d" },
        now,
      );

      expect(result[0]?.title).toBe("API message");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toContain("/users/me/messages?");
      expect(calls[1]?.url).toContain("/users/me/messages/api-message?");
      expect(calls.every((call) => call.authorization === "Bearer access-token")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
