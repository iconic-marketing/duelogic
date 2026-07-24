/**
 * Server-only Pinch Payments API client (sandbox/test environment).
 *
 * Credentials are read from server environment variables and never leave this
 * module. Access tokens are cached in memory and are never returned to
 * callers — use `pinchRequest` for API calls and `verifyPinchAuthentication`
 * for connectivity checks.
 */

const PINCH_TOKEN_URL = "https://auth.getpinch.com.au/connect/token";
const PINCH_VERSION = "2020.1";
// Refresh this many seconds before the token actually expires, so a token
// that is about to lapse is never used for an outgoing request.
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;

export class PinchError extends Error {}

/** Server misconfiguration: required environment variables are missing. */
export class PinchConfigError extends PinchError {}

/** The OAuth token request to Pinch failed. */
export class PinchAuthError extends PinchError {}

/** A Pinch API request failed after authentication succeeded. */
export class PinchApiError extends PinchError {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

// The `server-only` package is not installed in this project, so guard at
// runtime instead: importing this module into browser code fails immediately
// rather than silently bundling credentials.
function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new PinchError(
      "The Pinch client is server-only and must not be imported into browser code.",
    );
  }
}

interface PinchConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
}

function getConfig(): PinchConfig {
  const appId = process.env.PINCH_APP_ID;
  const appSecret = process.env.PINCH_APP_SECRET;
  const baseUrl = process.env.PINCH_API_BASE_URL;

  const missing = [
    !appId && "PINCH_APP_ID",
    !appSecret && "PINCH_APP_SECRET",
    !baseUrl && "PINCH_API_BASE_URL",
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0 || !appId || !appSecret || !baseUrl) {
    throw new PinchConfigError(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return { appId, appSecret, baseUrl: baseUrl.replace(/\/+$/, "") };
}

interface CachedToken {
  accessToken: string;
  /** Epoch milliseconds after which the token must not be reused. */
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let pendingTokenRequest: Promise<CachedToken> | null = null;

async function requestToken(): Promise<CachedToken> {
  const { appId, appSecret } = getConfig();
  const basicCredentials = Buffer.from(`${appId}:${appSecret}`).toString(
    "base64",
  );

  let response: Response;
  try {
    response = await fetch(PINCH_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicCredentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "api1",
      }).toString(),
      cache: "no-store",
    });
  } catch {
    // Deliberately drop the underlying error: fetch failures can echo
    // request details. The URL alone is safe and enough to diagnose.
    throw new PinchAuthError(
      `Could not reach the Pinch token endpoint (${PINCH_TOKEN_URL}).`,
    );
  }

  if (!response.ok) {
    throw new PinchAuthError(
      `Pinch token request failed with HTTP ${response.status}. Check the Pinch application credentials.`,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;

  if (!payload?.access_token || typeof payload.expires_in !== "number") {
    throw new PinchAuthError(
      "Pinch token response did not contain the expected fields.",
    );
  }

  return {
    accessToken: payload.access_token,
    expiresAt:
      Date.now() +
      Math.max(payload.expires_in - TOKEN_EXPIRY_MARGIN_SECONDS, 0) * 1000,
  };
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  assertServer();

  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }

  // Concurrent callers share one in-flight token request instead of each
  // hitting the auth server.
  if (!pendingTokenRequest) {
    pendingTokenRequest = requestToken().finally(() => {
      pendingTokenRequest = null;
    });
  }

  cachedToken = await pendingTokenRequest;
  return cachedToken.accessToken;
}

/**
 * Obtains (or reuses) a Pinch access token, throwing on failure.
 * Intentionally returns nothing so callers can never leak the token.
 */
export async function verifyPinchAuthentication(): Promise<void> {
  await getAccessToken();
}

export interface PinchRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serialised into the request body. */
  body?: unknown;
  /** Appended to the URL as a query string; undefined values are skipped. */
  searchParams?: Record<string, string | number | boolean | undefined>;
}

/**
 * Reusable helper for authenticated Pinch API calls. `path` is resolved
 * against PINCH_API_BASE_URL (currently the test environment), e.g.
 * `pinchRequest("payers")`.
 */
export async function pinchRequest<T>(
  path: string,
  options: PinchRequestOptions = {},
): Promise<T> {
  assertServer();
  const { baseUrl } = getConfig();

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const queryString = query.size > 0 ? `?${query.toString()}` : "";
  const url = `${baseUrl}/${path.replace(/^\/+/, "")}${queryString}`;
  const safePath = `${path.replace(/^\/+/, "")}${queryString}`;

  const performRequest = async (token: string): Promise<Response> => {
    try {
      return await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "pinch-version": PINCH_VERSION,
          "Content-Type": "application/json",
        },
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        cache: "no-store",
      });
    } catch {
      throw new PinchApiError(`Could not reach the Pinch API (${safePath}).`, 0);
    }
  };

  let response = await performRequest(await getAccessToken());

  // A 401 despite the expiry margin means the cached token was revoked or
  // clock-skewed; refresh once and retry before giving up.
  if (response.status === 401) {
    response = await performRequest(await getAccessToken(true));
  }

  if (!response.ok) {
    throw new PinchApiError(
      `Pinch API request to ${safePath} failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
