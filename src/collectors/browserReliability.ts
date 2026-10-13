import type { Page } from "playwright";
import type { SourceCoverage } from "../types/index.js";

export const defaultNavigationDelayMs = 350;
export const defaultSettleDelayMs = 300;

export type BrowserNavigationProgress = {
  phase: "navigating" | "ready" | "failed";
  url: string;
  title?: string;
  coverage?: SourceCoverage;
  cursor?: string | null;
};

export class BrowserSessionError extends Error {
  public constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

export const isBrowserFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:target page|browser|context).*(?:closed|disconnected)|page.*(?:crash|closed)|browser.*crash/iu.test(message);
};

export const waitBeforeNavigation = async (
  page: Page,
  lastNavigationAt: number,
  delayMs: number,
): Promise<number> => {
  const remaining = delayMs - (Date.now() - lastNavigationAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
  return Date.now();
};

/**
 * Navigation uses a short minimum gap, then waits on browser readiness
 * signals. The gap is deliberately not the readiness mechanism: modern
 * Moodle/Ed/Outlook pages can finish at different speeds.
 */
export const waitForPageReady = async (
  page: Page,
  timeoutMs: number,
  settleDelayMs: number,
): Promise<void> => {
  if (page.isClosed()) throw new BrowserSessionError("The browser page closed before it became ready.");

  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch((error: unknown) => {
    if (page.isClosed() || isBrowserFailure(error)) throw new BrowserSessionError("The browser closed while loading a page.", error);
  });
  await page.waitForFunction(
    () => document.readyState === "interactive" || document.readyState === "complete",
    undefined,
    { timeout: timeoutMs },
  );
  await page.locator("body").waitFor({ state: "attached", timeout: timeoutMs });
  // A bounded network-idle wait is useful for client-rendered shells, but
  // streaming pages are allowed to continue after the bound.
  // Moodle/EdStem/Outlook keep background requests open. Network idle is only
  // a short best-effort settle signal; it must never turn into a hidden page
  // loop or add several seconds to every bounded navigation.
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 1_500) }).catch((error: unknown) => {
    if (page.isClosed() || isBrowserFailure(error)) throw new BrowserSessionError("The browser closed while settling a page.", error);
  });
  if (settleDelayMs > 0) await page.waitForTimeout(settleDelayMs);
  if (page.isClosed()) throw new BrowserSessionError("The browser page closed before it could be read.");
};

export const closeWithTimeout = async (
  operation: Promise<void> | undefined,
  timeoutMs = 5_000,
): Promise<void> => {
  if (operation === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
};
