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

export interface SpendIntent {
  userAddress: string;
  amount: string; // 18-decimal string
  recipientHash?: string;
  transferType?: number;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  remainingDaily?: string;
  remainingBalance?: string;
}

export async function validateSpendIntent(
  prisma: PrismaClient,
  publicClient: PublicClient,
  intent: SpendIntent
): Promise<ValidationResult> {
  const { userAddress, amount, transferType } = intent;
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

  // 4. Sufficient deposited balance
  const balance = await getBalance(prisma, user.id, "usd");
  if (BigInt(balance) < amountBn) {
    return {
      allowed: false,
      reason: "Insufficient deposited balance",
      remainingBalance: balance,
    };
  }

  // 5. On-chain daily limit check
  let remainingDaily: bigint;
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
      };
    }
  } catch (err) {
    // If the call reverts, the EOA may not be registered on-chain
    return {
      allowed: false,
      reason: `On-chain limit check failed: ${err instanceof Error ? err.message : String(err)}`,
      remainingBalance: balance,
    };
  }

  // 6. Transfer type allowed (if specified)
  if (transferType !== undefined) {
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
          remainingDaily: remainingDaily.toString(),
          remainingBalance: balance,
        };
      }
    } catch (err) {
      return {
        allowed: false,
        reason: `Transfer type check failed: ${err instanceof Error ? err.message : String(err)}`,
        remainingDaily: remainingDaily.toString(),
        remainingBalance: balance,
      };
    }
  }

  return {
    allowed: true,
    remainingDaily: remainingDaily.toString(),
    remainingBalance: balance,
  };
}
