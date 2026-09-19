import { describe, expect, it } from "vitest";

import { parseNewsFeed } from "../src/collectors/news.js";

const now = new Date("2026-09-19T08:00:00.000Z");

describe("read-only article collectors", () => {
  it("parses RSS and Atom-shaped entries into stable news IDs", () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[New tools &amp; ideas]]></title><link>https://example.com/story</link><description><![CDATA[<p>Short summary.</p>]]></description><pubDate>Fri, 19 Sep 2026 07:00:00 GMT</pubDate></item></channel></rss>`;
    const items = parseNewsFeed(rss, "https://example.com/feed.xml", { now });

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toMatch(/^news:[a-f0-9]{24}$/u);
    expect(items[0]).toMatchObject({
      source: "news",
      title: "New tools & ideas",
      content: "Short summary.",
      url: "https://example.com/story",
      metadata: { feedHost: "example.com", sourceType: "rss" },
    });
  });
});
