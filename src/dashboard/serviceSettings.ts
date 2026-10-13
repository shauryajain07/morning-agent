import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { edStemOptionsFromEnvironment } from "../collectors/edstem.js";
import { gmailOptionsFromEnvironment, readGmailOAuthClientCredentials } from "../collectors/gmail.js";
import { githubOptionsFromEnvironment } from "../collectors/github.js";
import { moodleOptionsFromEnvironment } from "../collectors/moodle.js";
import { outlookOptionsFromEnvironment } from "../collectors/outlook.js";
import { defaultSettings } from "../config/settings.js";
import type { RunSourceKey } from "../types/index.js";

export const dashboardSourceOrder: RunSourceKey[] = [
  "downloads",
  "calendar",
  "gmail",
  "github",
  "news",
  "edstem",
  "moodle",
  "outlook",
];

export const dashboardServiceCatalog = [
  { key: "downloads", label: "Files", description: "Check files in your Downloads folder.", login: null },
  { key: "calendar", label: "Calendar", description: "Calendar collection is not connected yet.", login: null },
  { key: "gmail", label: "Gmail", description: "Read recent messages with read-only access.", login: "oauth" },
  { key: "github", label: "GitHub", description: "Public repositories need no sign-in. Private repositories need GITHUB_TOKEN.", login: null },
  { key: "news", label: "Daily news", description: "Collect recent stories from your news sources.", login: null },
  { key: "edstem", label: "Ed Lessons", description: "Check lessons and updates from your EdStem courses.", login: "browser" },
  { key: "moodle", label: "Moodle", description: "Check course notices, assignments, and files.", login: "browser" },
  { key: "outlook", label: "Outlook", description: "Read recent messages from Outlook.", login: "browser" },
] as const satisfies ReadonlyArray<{
  key: RunSourceKey;
  label: string;
  description: string;
  login: "oauth" | "browser" | null;
}>;

export type DashboardServiceLoginKey = "gmail" | "edstem" | "moodle" | "outlook";
type EnabledServices = Record<RunSourceKey, boolean>;
type StoredSettings = {
  version: 1;
  order: RunSourceKey[];
  enabled: EnabledServices;
  connectedAt: Partial<Record<DashboardServiceLoginKey, string>>;
};

export type LoginState = "not_connected" | "connected" | "opening" | "awaiting_user" | "error" | "closed";
export type ServiceLoginStatus = {
  state: LoginState;
  connectedAt?: string;
  message?: string;
};

export type PublicDashboardSettings = {
  order: RunSourceKey[];
  enabled: EnabledServices;
  services: Array<{
    key: RunSourceKey;
    label: string;
    description: string;
    login: "oauth" | "browser" | null;
    loginConfigured: boolean;
  }>;
  connections: Partial<Record<DashboardServiceLoginKey, ServiceLoginStatus>>;
};

export type StartLoginResult = {
  state: LoginState;
  authorizationUrl?: string;
};

const settingsPath = join(dirname(defaultSettings.databasePath), "dashboard-settings.json");
const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const gmailAuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const gmailTokenEndpoint = "https://oauth2.googleapis.com/token";
const gmailCallbackTimeoutMs = 15 * 60 * 1_000;
const validSources = new Set<RunSourceKey>(dashboardSourceOrder);
const loginKeys = new Set<DashboardServiceLoginKey>(["gmail", "edstem", "moodle", "outlook"]);

const loginRuntime = new Map<DashboardServiceLoginKey, ServiceLoginStatus>();
type BrowserLoginSession = {
  context: BrowserContext;
  page: Page;
  browser?: Browser;
  ownsContext: boolean;
  persistentContext: boolean;
};
const browserLoginSessions = new Map<Exclude<DashboardServiceLoginKey, "gmail">, BrowserLoginSession>();
let gmailSession: { server: Server; authorizationUrl: string; timeout: NodeJS.Timeout } | undefined;
let settingsMutationQueue: Promise<void> = Promise.resolve();

const hasErrno = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const defaultEnabledServices = (): EnabledServices => {
  const moodle = moodleOptionsFromEnvironment();
  const outlook = outlookOptionsFromEnvironment();
  const edstem = edStemOptionsFromEnvironment();
  const gmail = gmailOptionsFromEnvironment();
  const github = githubOptionsFromEnvironment();
  return {
    downloads: true,
    calendar: false,
    gmail: gmail.enabled === true,
    github: github.enabled,
    news: true,
    edstem: edstem.enabled,
    moodle: moodle.enabled === true,
    outlook: outlook.enabled === true,
  };
};

const defaultStoredSettings = (): StoredSettings => ({
  version: 1,
  order: [...dashboardSourceOrder],
  enabled: defaultEnabledServices(),
  connectedAt: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSource = (value: unknown): value is RunSourceKey =>
  typeof value === "string" && validSources.has(value as RunSourceKey);

const parseStoredSettings = (value: unknown): StoredSettings => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.order) || !isRecord(value.enabled)) {
    throw new Error("Dashboard settings are invalid. Remove .data/dashboard-settings.json and try again.");
  }
  const order = value.order;
  if (order.length !== dashboardSourceOrder.length || order.some((source) => !isSource(source)) || new Set(order).size !== dashboardSourceOrder.length) {
    throw new Error("Dashboard service order is invalid. Remove .data/dashboard-settings.json and try again.");
  }
  const enabled = {} as EnabledServices;
  for (const source of dashboardSourceOrder) {
    const selected = value.enabled[source];
    if (typeof selected !== "boolean") {
      throw new Error("Dashboard service settings are invalid. Remove .data/dashboard-settings.json and try again.");
    }
    enabled[source] = selected;
  }
  const connectedAt: StoredSettings["connectedAt"] = {};
  if (isRecord(value.connectedAt)) {
    for (const service of loginKeys) {
      const timestamp = value.connectedAt[service];
      if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) connectedAt[service] = timestamp;
    }
  }
  return { version: 1, order: [...order as RunSourceKey[]], enabled, connectedAt };
};

const readStoredSettings = async (): Promise<StoredSettings> => {
  try {
    const contents = await readFile(settingsPath, "utf8");
    return parseStoredSettings(JSON.parse(contents) as unknown);
  } catch (error: unknown) {
    if (hasErrno(error, "ENOENT")) return defaultStoredSettings();
    if (error instanceof SyntaxError) {
      throw new Error("Dashboard settings are not valid JSON. Remove .data/dashboard-settings.json and try again.");
    }
    throw error;
  }
};

const writeStoredSettings = async (settings: StoredSettings): Promise<void> => {
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, settingsPath);
};

const mutateStoredSettings = (update: (settings: StoredSettings) => StoredSettings): Promise<void> => {
  const task = settingsMutationQueue.then(async () => {
    const settings = await readStoredSettings();
    await writeStoredSettings(update(settings));
  });
  settingsMutationQueue = task.catch(() => undefined);
  return task;
};

const withSettingsQueue = async <T>(read: () => Promise<T>): Promise<T> => {
  await settingsMutationQueue;
  return read();
};

const loginConfigured = async (service: DashboardServiceLoginKey): Promise<boolean> => {
  if (service === "gmail") {
    const options = gmailOptionsFromEnvironment();
    if (options.clientId !== undefined && options.clientSecret !== undefined) return true;
    try {
      await readGmailOAuthClientCredentials(options.credentialsPath ?? ".gmail-credentials.json");
      return true;
    } catch {
      return false;
    }
  }
  if (service === "moodle") return moodleOptionsFromEnvironment().baseUrl !== undefined;
  return true;
};

const publicConnections = (settings: StoredSettings): PublicDashboardSettings["connections"] => {
  const connections: PublicDashboardSettings["connections"] = {};
  for (const service of loginKeys) {
    const runtime = loginRuntime.get(service);
    if (runtime !== undefined) {
      connections[service] = {
        ...runtime,
        ...(settings.connectedAt[service] === undefined ? {} : { connectedAt: settings.connectedAt[service] }),
      };
    } else if (settings.connectedAt[service] !== undefined) {
      connections[service] = { state: "connected", connectedAt: settings.connectedAt[service] };
    } else {
      connections[service] = { state: "not_connected" };
    }
  }
  return connections;
};

export const getDashboardSettings = async (): Promise<PublicDashboardSettings> => withSettingsQueue(async () => {
  const stored = await readStoredSettings();
  const services = await Promise.all(dashboardServiceCatalog.map(async (service) => ({
    ...service,
    loginConfigured: service.login === null ? true : await loginConfigured(service.key as DashboardServiceLoginKey),
  })));
  return {
    order: stored.order,
    enabled: stored.enabled,
    services,
    connections: publicConnections(stored),
  };
});

export const isDashboardServiceLoginKey = (value: unknown): value is DashboardServiceLoginKey =>
  typeof value === "string" && loginKeys.has(value as DashboardServiceLoginKey);

export const saveDashboardPreferences = async (value: unknown): Promise<PublicDashboardSettings> => {
  if (!isRecord(value) || !Array.isArray(value.order) || !isRecord(value.enabled)) {
    throw new Error("Send a service order and enabled settings.");
  }
  const order = value.order;
  if (order.length !== dashboardSourceOrder.length || order.some((source) => !isSource(source)) || new Set(order).size !== dashboardSourceOrder.length) {
    throw new Error("Include each service once in the requested order.");
  }
  const enabled = {} as EnabledServices;
  for (const source of dashboardSourceOrder) {
    if (typeof value.enabled[source] !== "boolean") throw new Error(`Choose whether ${source} is enabled.`);
    enabled[source] = value.enabled[source] as boolean;
  }
  await mutateStoredSettings((stored) => ({ ...stored, order: [...order], enabled }));
  return getDashboardSettings();
};

const connectionTimestamp = (): string => new Date().toISOString();

const markConnected = async (service: DashboardServiceLoginKey): Promise<void> => {
  const connectedAt = connectionTimestamp();
  await mutateStoredSettings((stored) => ({
    ...stored,
    connectedAt: { ...stored.connectedAt, [service]: connectedAt },
  }));
  loginRuntime.set(service, { state: "connected", connectedAt });
};

const startBrowserLogin = async (service: Exclude<DashboardServiceLoginKey, "gmail">): Promise<StartLoginResult> => {
  if (browserLoginSessions.has(service)) return { state: "awaiting_user" };
  loginRuntime.set(service, { state: "opening" });

  const config = service === "moodle"
    ? moodleOptionsFromEnvironment()
    : service === "edstem"
      ? edStemOptionsFromEnvironment()
      : outlookOptionsFromEnvironment();
  if (service === "moodle" && config.baseUrl === undefined) {
    throw new Error("Set MOODLE_BASE_URL in your .env file before signing in to Moodle.");
  }
  const targetUrl = config.baseUrl;
  if (targetUrl === undefined) throw new Error(`Could not find a sign-in URL for ${service}.`);
  const defaultProfile = service === "moodle" ? ".browser-profile" : service === "edstem" ? ".edstem-browser-profile" : ".outlook-browser-profile";
  const profileDirectory = resolve(config.profileDirectory ?? join(process.cwd(), defaultProfile));

  let context: BrowserContext | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let ownsContext = true;
  let persistentContext = false;
  try {
    if (config.cdpUrl !== undefined) {
      browser = await chromium.connectOverCDP(config.cdpUrl);
      const existingContext = browser.contexts()[0];
      context = existingContext ?? await browser.newContext();
      ownsContext = existingContext === undefined;
      page = await context.newPage();
    } else {
      context = await chromium.launchPersistentContext(profileDirectory, {
        headless: false,
        viewport: null,
        args: ["--window-size=1280,900", "--window-position=80,80"],
        ignoreDefaultArgs: ["--enable-automation"],
      });
      persistentContext = true;
      page = context.pages()[0] ?? await context.newPage();
    }
    const session: BrowserLoginSession = { context, page, ...(browser === undefined ? {} : { browser }), ownsContext, persistentContext };
    browserLoginSessions.set(service, session);
    page.on("close", () => {
      if (browserLoginSessions.get(service) !== session) return;
      browserLoginSessions.delete(service);
      const latest = loginRuntime.get(service);
      if (latest?.state === "awaiting_user" || latest?.state === "opening") {
        loginRuntime.set(service, { state: "closed", message: "The sign-in window closed before you finished setup." });
      }
    });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    loginRuntime.set(service, { state: "awaiting_user" });
    return { state: "awaiting_user" };
  } catch (error: unknown) {
    browserLoginSessions.delete(service);
    if (persistentContext) await context?.close().catch(() => undefined);
    else {
      await page?.close().catch(() => undefined);
      if (ownsContext) await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "Could not open the sign-in window.";
    loginRuntime.set(service, { state: "error", message });
    throw new Error(message);
  }
};

const exchangeGmailAuthorizationCode = async (
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<Record<string, unknown>> => {
  const response = await fetch(gmailTokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    const errorDescription = isRecord(payload) ? payload.error_description : undefined;
    throw new Error(`Google token exchange failed: ${typeof errorDescription === "string" ? errorDescription : "unknown error"}`);
  }
  if (!isRecord(payload)) throw new Error("Google returned an invalid token response.");
  return payload;
};

const sendCallbackPage = (response: ServerResponse, status: number, heading: string, message: string): void => {
  const safeHeading = heading.replace(/[&<>"']/gu, "");
  const safeMessage = message.replace(/[&<>"']/gu, "");
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${safeHeading}</title><body><main><h1>${safeHeading}</h1><p>${safeMessage}</p><p>You can close this tab and return to Morning Agent.</p></main></body></html>`);
};

const finishGmailSession = (status: ServiceLoginStatus): void => {
  const session = gmailSession;
  gmailSession = undefined;
  if (session !== undefined) {
    clearTimeout(session.timeout);
    session.server.close();
  }
  loginRuntime.set("gmail", status);
};

const startGmailLogin = async (): Promise<StartLoginResult> => {
  if (gmailSession !== undefined) return { state: "awaiting_user", authorizationUrl: gmailSession.authorizationUrl };
  loginRuntime.set("gmail", { state: "opening" });
  const options = gmailOptionsFromEnvironment();
  let clientId = options.clientId;
  let clientSecret = options.clientSecret;
  if (clientId === undefined || clientSecret === undefined) {
    const credentialsPath = options.credentialsPath ?? ".gmail-credentials.json";
    const credentials = await readGmailOAuthClientCredentials(credentialsPath);
    clientId ??= credentials.clientId;
    clientSecret ??= credentials.clientSecret;
  }
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error("Add Gmail OAuth client credentials in .gmail-credentials.json or set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.");
  }

  const state = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/oauth2callback") {
        sendCallbackPage(response, 404, "Not found", "This local address is only for Gmail sign-in.");
        return;
      }
      const authorizationError = requestUrl.searchParams.get("error");
      if (authorizationError !== null) {
        finishGmailSession({ state: "error", message: `Gmail sign-in was not completed: ${authorizationError}.` });
        sendCallbackPage(response, 400, "Gmail sign-in was not completed", "Return to Morning Agent and try again.");
        return;
      }
      const code = requestUrl.searchParams.get("code");
      if (requestUrl.searchParams.get("state") !== state || code === null || code.length === 0) {
        finishGmailSession({ state: "error", message: "Google returned an invalid sign-in response. Try again." });
        sendCallbackPage(response, 400, "Sign-in could not be verified", "Return to Morning Agent and try again.");
        return;
      }
      try {
        const token = await exchangeGmailAuthorizationCode(code, redirectUri, clientId as string, clientSecret as string);
        if (typeof token.refresh_token !== "string" || token.refresh_token.length === 0) {
          throw new Error("Google did not return a refresh token. Try signing in again and approve access.");
        }
        const tokenPath = resolve(options.tokenPath ?? ".gmail-token.json");
        await mkdir(dirname(tokenPath), { recursive: true });
        await writeFile(tokenPath, `${JSON.stringify({ ...token, scope: gmailScope }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(tokenPath, 0o600);
        await markConnected("gmail");
        sendCallbackPage(response, 200, "Gmail is connected", "Morning Agent can now read Gmail with read-only access.");
        finishGmailSession({ state: "connected", connectedAt: connectionTimestamp() });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Gmail sign-in failed.";
        sendCallbackPage(response, 500, "Gmail sign-in failed", "Return to Morning Agent and try again.");
        finishGmailSession({ state: "error", message });
      }
    })().catch(() => undefined);
  });

  const redirectUri = await new Promise<string>((resolveRedirect, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not start the local Gmail sign-in callback."));
        return;
      }
      resolveRedirect(`http://127.0.0.1:${address.port}/oauth2callback`);
    });
  });
  const authorizationUrl = new URL(gmailAuthorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: gmailScope,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  const timeout = setTimeout(() => finishGmailSession({ state: "error", message: "Gmail sign-in timed out. Start again when you are ready." }), gmailCallbackTimeoutMs);
  timeout.unref();
  gmailSession = { server, authorizationUrl: authorizationUrl.toString(), timeout };
  loginRuntime.set("gmail", { state: "awaiting_user" });
  return { state: "awaiting_user", authorizationUrl: authorizationUrl.toString() };
};

export const startDashboardServiceLogin = async (service: DashboardServiceLoginKey): Promise<StartLoginResult> => {
  try {
    return service === "gmail" ? await startGmailLogin() : await startBrowserLogin(service);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Could not start sign-in.";
    loginRuntime.set(service, { state: "error", message });
    throw new Error(message);
  }
};

export const completeDashboardServiceLogin = async (service: DashboardServiceLoginKey): Promise<PublicDashboardSettings> => {
  if (service === "gmail") throw new Error("Finish Gmail sign-in in the Google tab.");
  const session = browserLoginSessions.get(service);
  if (session === undefined) throw new Error("The sign-in window is not open. Start sign-in again.");
  loginRuntime.set(service, { state: "opening" });
  browserLoginSessions.delete(service);
  try {
    if (session.persistentContext) await session.context.close();
    else {
      await session.page.close();
      if (session.ownsContext) await session.context.close();
      await session.browser?.close();
    }
    await markConnected(service);
    return getDashboardSettings();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Could not finish sign-in.";
    loginRuntime.set(service, { state: "error", message });
    throw new Error(message);
  }
};

export const cancelDashboardServiceLogin = async (service: DashboardServiceLoginKey): Promise<PublicDashboardSettings> => {
  if (service === "gmail") finishGmailSession({ state: "not_connected" });
  else {
    const session = browserLoginSessions.get(service);
    browserLoginSessions.delete(service);
    if (session !== undefined) {
      if (session.persistentContext) await session.context.close();
      else {
        await session.page.close();
        if (session.ownsContext) await session.context.close();
        await session.browser?.close();
      }
    }
  }
  const stored = await withSettingsQueue(readStoredSettings);
  loginRuntime.set(service, stored.connectedAt[service] === undefined
    ? { state: "not_connected" }
    : { state: "connected", connectedAt: stored.connectedAt[service] });
  return getDashboardSettings();
};

export const shutdownDashboardServiceLogins = async (): Promise<void> => {
  if (gmailSession !== undefined) finishGmailSession({ state: "not_connected" });
  const sessions = Array.from(browserLoginSessions.values());
  browserLoginSessions.clear();
  await Promise.all(sessions.map(async (session) => {
    if (session.persistentContext) await session.context.close().catch(() => undefined);
    else {
      await session.page.close().catch(() => undefined);
      if (session.ownsContext) await session.context.close().catch(() => undefined);
      await session.browser?.close().catch(() => undefined);
    }
  }));
};
