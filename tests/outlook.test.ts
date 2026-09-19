import { describe, expect, it } from "vitest";

import { extractOutlookEmailItems, type OutlookMessageSnapshot } from "../src/collectors/outlookBrowser.js";

describe("Outlook browser adapter", () => {
  const now = new Date("2026-09-19T08:00:00+08:00");

  it("keeps only the configured lookback window and preserves ISO timezones", () => {
    const records: OutlookMessageSnapshot[] = [
      {
        id: "recent",
        text: "HKU Engineering\nAssignment update\nThe submission window closes tonight.",
        ariaLabel: "Unread",
        href: "https://outlook.office.com/mail/recent",
        dateText: "2026-09-18T23:58:00.000Z",
        unread: true,
      },
      {
        id: "old",
        text: "Old sender\nOld message\nThis is outside the window.",
        ariaLabel: "",
        href: "https://outlook.office.com/mail/old",
        dateText: "2026-09-17T23:59:00.000Z",
        unread: false,
      },
    ];

    const result = extractOutlookEmailItems(records, now);

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Assignment update");
    expect(result[0]?.createdAt?.toISOString()).toBe("2026-09-18T23:58:00.000Z");
    expect(result[0]?.metadata).toMatchObject({
      provider: "outlook",
      sender: "HKU Engineering",
      unread: true,
    });
  });

  it("deduplicates a message seen in multiple virtualized list snapshots", () => {
    const record: OutlookMessageSnapshot = {
      id: "same-conversation",
      text: "Student Services\nRegistration reminder\nPlease review the dates.",
      ariaLabel: "",
      href: "https://outlook.office.com/mail/same-conversation",
      dateText: "Today 6:30 AM",
      unread: false,
    };

    const result = extractOutlookEmailItems([record, { ...record, text: `${record.text}\n` }], now);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toMatch(/^outlook:[a-f0-9]{24}$/u);
  });

  it("uses the aria label when the visible row has no useful line structure", () => {
    const result = extractOutlookEmailItems(
      [
        {
          id: "aria-row",
          text: "",
          ariaLabel: "Unread, Library, Reading list available, Today 7:10 AM",
          href: "",
          dateText: "Today 7:10 AM",
          unread: true,
        },
      ],
      now,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.metadata.sender).toBe("Unread, Library, Reading list available, Today 7:10 AM");
  });
});
