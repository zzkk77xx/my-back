/**
 * Pre-validation engine for spend intents.
 *
 * Checks are ordered cheap → expensive:
 *   1. User exists
 *   2. Amount > 0
 *   3. Amount <= $10k auto-sign cap
 *   4. User has sufficient deposited balance
 *   5. On-chain daily limit check
 *   6. Transfer type allowed
 */

import type { PrismaClient } from "@prisma/client";
import type { PublicClient } from "viem";
import { getBalance } from "./ledger.js";
import { SPEND_INTERACTOR_ABI } from "./safe.js";

// $10,000 in 18-decimal
export const AUTO_SIGN_LIMIT_USD = 10_000n * 10n ** 18n;

// Velocity limits (18-decimal USD). Off-chain complement to on-chain 24h limit.
export const VELOCITY_7D_LIMIT_USD = BigInt(
  process.env.VELOCITY_7D_LIMIT_USD ?? (50_000n * 10n ** 18n).toString(),
);
export const VELOCITY_30D_LIMIT_USD = BigInt(
  process.env.VELOCITY_30D_LIMIT_USD ?? (150_000n * 10n ** 18n).toString(),
);

export interface SpendIntent {
  userAddress: string;
  amount: string; // 18-decimal string
  recipientHash?: string;
  transferType?: number;
  /** Skip on-chain daily-limit & transfer-type checks (used by Path B bank transfers). */
  skipOnChainChecks?: boolean;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  remainingDaily?: string;
  remainingBalance?: string;
  remaining7d?: string;
  remaining30d?: string;
  recipientKnown?: boolean;
  firstTimeRecipient?: boolean;
}

export async function validateSpendIntent(
  prisma: PrismaClient,
  publicClient: PublicClient,
  intent: SpendIntent,
): Promise<ValidationResult> {
  const { userAddress, amount, transferType, skipOnChainChecks } = intent;
  const amountBn = BigInt(amount);

  // 1. User exists
  const user = await prisma.user.findUnique({
    where: { address: userAddress.toLowerCase() },
  });
  if (!user) {
    return { allowed: false, reason: "User not registered" };
  }

  // 2. Amount > 0
  if (amountBn <= 0n) {
    return { allowed: false, reason: "Amount must be greater than zero" };
  }

  // 3. Amount <= auto-sign cap
  if (amountBn > AUTO_SIGN_LIMIT_USD) {
    return {
      allowed: false,
      reason: `Amount exceeds auto-sign limit of $10,000 (${AUTO_SIGN_LIMIT_USD.toString()})`,
    };
  }

  // 4. Velocity checks (7d / 30d rolling spend limits)
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const recentSpends = await prisma.balanceLedger.findMany({
    where: {
      userId: user.id,
      token: "usd",
      type: "spend",
      createdAt: { gte: thirtyDaysAgo },
    },
    select: { amount: true, createdAt: true },
  });

  let spend7d = 0n;
  let spend30d = 0n;
  for (const entry of recentSpends) {
    const amt = BigInt(entry.amount);
    spend30d += amt;
    if (entry.createdAt >= sevenDaysAgo) {
      spend7d += amt;
    }
  }

  const remaining7d = VELOCITY_7D_LIMIT_USD - spend7d;
  const remaining30d = VELOCITY_30D_LIMIT_USD - spend30d;

  if (spend7d + amountBn > VELOCITY_7D_LIMIT_USD) {
    return {
      allowed: false,
      reason: "Exceeds 7-day rolling spend limit",
      remaining7d: remaining7d.toString(),
      remaining30d: remaining30d.toString(),
    };
  }

  if (spend30d + amountBn > VELOCITY_30D_LIMIT_USD) {
    return {
      allowed: false,
      reason: "Exceeds 30-day rolling spend limit",
      remaining7d: remaining7d.toString(),
      remaining30d: remaining30d.toString(),
    };
  }

  // 5. Beneficiary registry check
  if (intent.recipientHash) {
    const beneficiary = await prisma.beneficiaryRegistry.findUnique({
      where: {
        userId_recipientHash: {
          userId: user.id,
          recipientHash: intent.recipientHash.toLowerCase(),
        },
      },
    });

    if (beneficiary?.status === "blocked") {
      return {
        allowed: false,
        reason: "Recipient is blocked",
        remaining7d: remaining7d.toString(),
        remaining30d: remaining30d.toString(),
      };
    }

    // Flag first-time recipients (non-blocking warning)
    var recipientKnown = !!beneficiary;
    var firstTimeRecipient = !beneficiary;
  }

  // 6. Sufficient deposited balance
  const balance = await getBalance(prisma, user.id, "usd");
  if (BigInt(balance) < amountBn) {
    return {
      allowed: false,
      reason: "Insufficient deposited balance",
      remainingBalance: balance,
      remaining7d: remaining7d.toString(),
      remaining30d: remaining30d.toString(),
    };
  }

  // 7. On-chain daily limit check (Path A / card payments only)
  let remainingDaily: bigint | undefined;
  if (!skipOnChainChecks) {
    try {
      remainingDaily = (await publicClient.readContract({
        address: user.spendInteractorAddress as `0x${string}`,
        abi: SPEND_INTERACTOR_ABI,
        functionName: "getRemainingLimit",
        args: [userAddress as `0x${string}`],
      })) as bigint;

      if (remainingDaily < amountBn) {
        return {
          allowed: false,
          reason: "Exceeds on-chain daily spending limit",
          remainingDaily: remainingDaily.toString(),
          remainingBalance: balance,
          remaining7d: remaining7d.toString(),
          remaining30d: remaining30d.toString(),
        };
      }
    } catch (err) {
      // If the call reverts, the EOA may not be registered on-chain
      return {
        allowed: false,
        reason: `On-chain limit check failed: ${err instanceof Error ? err.message : String(err)}`,
        remainingBalance: balance,
        remaining7d: remaining7d.toString(),
        remaining30d: remaining30d.toString(),
      };
    }
  }

  // 8. Transfer type allowed (Path A only)
  if (!skipOnChainChecks && transferType !== undefined) {
    try {
      const bitmap = (await publicClient.readContract({
        address: user.spendInteractorAddress as `0x${string}`,
        abi: SPEND_INTERACTOR_ABI,
        functionName: "getAllowedTypesBitmap",
        args: [userAddress as `0x${string}`],
      })) as number;

      const typeBit = 1 << transferType;
      if ((bitmap & typeBit) === 0) {
        return {
          allowed: false,
          reason: `Transfer type ${transferType} not allowed for this EOA`,
          remainingDaily: remainingDaily?.toString(),
          remainingBalance: balance,
          remaining7d: remaining7d.toString(),
          remaining30d: remaining30d.toString(),
        };
      }
    } catch (err) {
      return {
        allowed: false,
        reason: `Transfer type check failed: ${err instanceof Error ? err.message : String(err)}`,
        remainingDaily: remainingDaily?.toString(),
        remainingBalance: balance,
        remaining7d: remaining7d.toString(),
        remaining30d: remaining30d.toString(),
      };
    }
  }

  return {
    allowed: true,
    remainingDaily: remainingDaily?.toString(),
    remainingBalance: balance,
    remaining7d: remaining7d.toString(),
    remaining30d: remaining30d.toString(),
    recipientKnown: recipientKnown ?? undefined,
    firstTimeRecipient: firstTimeRecipient ?? undefined,
  };
}
