import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  gmailOptionsFromEnvironment,
  readGmailOAuthClientCredentials,
} from "./collectors/gmail.js";

const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";

type AuthorizationResult = {
  code: string;
  redirectUri: string;
};

const openBrowser = (url: string): void => {
  execFile("open", [url], (error) => {
    if (error !== undefined) console.log(`Open this URL manually if Google did not open: ${url}`);
  });
};

const waitForAuthorization = async (
  clientId: string,
  clientSecret: string,
): Promise<AuthorizationResult> => {
  const state = randomBytes(24).toString("hex");
  const server = createServer();
  let redirectUri: string | undefined;
  const result = await new Promise<AuthorizationResult>((resolveResult, reject) => {
    server.once("error", reject);
    server.on("request", (request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/oauth2callback") {
        response.writeHead(404).end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      const returnedState = requestUrl.searchParams.get("state");
      if (error !== null) {
        response.writeHead(400).end("Gmail authorization was denied. You can close this window.");
        reject(new Error(`Gmail authorization failed: ${error}`));
        return;
      }
      if (returnedState !== state || code === null || code.length === 0) {
        response.writeHead(400).end("Invalid Gmail authorization response. You can close this window.");
        reject(new Error("Gmail authorization returned an invalid state or no authorization code."));
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<p>Morning Agent Gmail access is connected. You can close this window.</p>");
      if (redirectUri === undefined) {
        reject(new Error("Gmail authorization callback was received before the local server was ready."));
        return;
      }
      resolveResult({ code, redirectUri });
      server.close();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not start the local Gmail authorization callback."));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const authorizationUrl = new URL(authorizationEndpoint);
      authorizationUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: gmailScope,
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
      console.log("Opening Google Gmail authorization in your browser...");
      openBrowser(authorizationUrl.toString());
      console.log("Approve the read-only Gmail permission, then return here.");
    });
  });
  return result;
};

const exchangeAuthorizationCode = async (
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<Record<string, unknown>> => {
  const response = await fetch(tokenEndpoint, {
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
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const error = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).error_description : undefined;
    throw new Error(`Google token exchange failed: ${typeof error === "string" ? error : "unknown error"}`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Google returned an invalid token response.");
  }
  return payload as Record<string, unknown>;
};

const main = async (): Promise<void> => {
  const options = gmailOptionsFromEnvironment();
  const credentialsPath = options.credentialsPath ?? ".gmail-credentials.json";
  const tokenPath = options.tokenPath ?? ".gmail-token.json";
  const credentials = await readGmailOAuthClientCredentials(credentialsPath);
  const authorization = await waitForAuthorization(credentials.clientId, credentials.clientSecret);
  const token = await exchangeAuthorizationCode(
    authorization.code,
    authorization.redirectUri,
    credentials.clientId,
    credentials.clientSecret,
  );
  if (typeof token.refresh_token !== "string" || token.refresh_token.length === 0) {
    throw new Error("Google did not return a refresh token. Run the login again and approve consent.");
  }

  const outputPath = resolve(tokenPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ ...token, scope: gmailScope }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(`Saved Gmail OAuth token to ${outputPath}`);
  console.log("You can now run: npm run morning -- --dry-run --verbose");
};

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "Gmail login failed.");
  process.exitCode = 1;
}
