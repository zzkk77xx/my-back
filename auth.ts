/**
 * Privy JWT authentication middleware.
 *
 * Verifies the `Authorization: Bearer <access_token>` header sent by the
 * Privy-authenticated frontend and attaches the decoded payload to the request.
 *
 * Env vars:
 *   PRIVY_APP_ID     - Privy application ID (same as VITE_PRIVY_APP_ID in the frontend)
 *   PRIVY_APP_SECRET - Privy application secret (from the Privy dashboard)
 */

import { PrivyClient } from "@privy-io/node";
import type { NextFunction, Request, Response } from "express";

// Extend Express Request with the verified Privy user ID
declare global {
  namespace Express {
    interface Request {
      privyUserId?: string;
    }
  }
}

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS === "true";

if (TEST_AUTH_BYPASS) {
  console.warn(
    "[auth] TEST_AUTH_BYPASS enabled — accepting X-Test-User-Id header instead of Privy tokens. DO NOT use in production!",
  );
} else if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
  console.warn(
    "[auth] PRIVY_APP_ID or PRIVY_APP_SECRET not set — requirePrivyAuth middleware will reject all requests",
  );
}

const privy =
  PRIVY_APP_ID && PRIVY_APP_SECRET
    ? new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET })
    : null;

/**
 * Express middleware that requires a valid Privy access token.
 * On success, sets `req.privyUserId` to the authenticated user's DID.
 * Returns 401 if the token is missing or invalid.
 */
export async function requirePrivyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Test bypass: accept X-Test-User-Id header when TEST_AUTH_BYPASS=true
  if (TEST_AUTH_BYPASS) {
    const testUserId = req.headers["x-test-user-id"] as string | undefined;
    if (testUserId) {
      req.privyUserId = testUserId;
      next();
      return;
    }
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  if (!privy) {
    res.status(500).json({
      error: "Auth not configured (PRIVY_APP_ID / PRIVY_APP_SECRET missing)",
    });
    return;
  }

  try {
    const payload = await privy.utils().auth().verifyAccessToken(token);
    req.privyUserId = payload.user_id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired access token" });
  }
}
