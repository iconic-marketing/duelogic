import type { NextRequest } from "next/server";

/**
 * Server-only localhost gate for development-only API routes.
 *
 * Extracted verbatim from the dev payer and payment-date routes, which
 * carried identical copies; the behaviour is unchanged. Routes call
 * `isDirectLocalhostRequest` and answer 404 when it returns false, so
 * tunnelled (ngrok), proxied, and deployed requests are all rejected before
 * any Pinch call is made.
 */

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts: the
// `server-only` package is not installed in this project, so fail at import
// time if this module ever reaches browser code.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev localhost guard is server-only and must not be imported into browser code.",
  );
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function hostHeaderIsLocal(hostHeader: string | null): boolean {
  if (!hostHeader) {
    return false;
  }
  const value = hostHeader.trim().toLowerCase();
  if (value === "::1") {
    // Bracket-less IPv6 loopback without a port cannot be URL-parsed below.
    return true;
  }
  try {
    // Handles ports and the bracketed IPv6 form, e.g. "[::1]:3000".
    const hostname = new URL(`http://${value}`).hostname.replace(
      /^\[|\]$/g,
      "",
    );
    return LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

function isLoopbackAddress(value: string): boolean {
  const address = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (address === "::1" || address === "localhost") {
    return true;
  }
  if (address.startsWith("::ffff:")) {
    return isLoopbackAddress(address.slice("::ffff:".length));
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

/**
 * The Next dev server stamps x-forwarded-for/host/proto onto every request,
 * including direct localhost ones (verified empirically), so rejecting on
 * header *presence* would reject everything. Instead every forwarded value
 * must itself be loopback/local: tunnels and proxies (ngrok, Vercel) put
 * public hostnames, public client IPs, or https here, and are rejected.
 */
export function isDirectLocalhostRequest(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  if (!hostHeaderIsLocal(request.headers.get("host"))) {
    return false;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost !== null && !hostHeaderIsLocal(forwardedHost)) {
    return false;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null) {
    const entries = forwardedFor
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (entries.length === 0 || !entries.every(isLoopbackAddress)) {
      return false;
    }
  }

  // `next dev` serves plain http; a forwarded https proto indicates a tunnel.
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto !== null) {
    const firstProto = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (firstProto !== "http") {
      return false;
    }
  }

  return true;
}
