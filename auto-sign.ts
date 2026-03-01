/**
 * Bank auto-sign service — Path B (checking account / signer EOA).
 *
 * Flow:
 *   1. Signer signs a transfer intent (amount, recipient, token).
 *   2. Bank receives the intent and validates guardrails via the policy engine
 *      (balance, velocity, $10k cap, on-chain limits).
 *   3a. If approved → bank calls unlink.withdraw() to send funds from pool
 *       to recipient, debits user ledger.
 *   3b. If rejected → intent is marked "pending_review" for manual confirmation
 *       (phone call or other out-of-band verification).
 *
 * All approve/reject decisions are recorded to the audit log.
 *
 * Note: This is NOT the debit-card path (Path A). Path A goes through
 * SpendInteractor → event → watcher → Unlink withdrawal automatically.
 */

import type { PrismaClient } from "@prisma/client";
import type { Unlink } from "@unlink-xyz/node";
import type { PublicClient } from "viem";
import { AUDIT_ACTIONS, logAudit } from "./audit.js";
import { debitBalance, InsufficientBalanceError } from "./ledger.js";
import { validateSpendIntent } from "./policy.js";

// Default USDC decimals — used to convert 18-decimal USD to token units
const DEFAULT_TOKEN_DECIMALS = Number(process.env.DEFAULT_TOKEN_DECIMALS ?? 6);
const DEFAULT_TOKEN_ADDRESS = (process.env.DEFAULT_TOKEN_ADDRESS ??
  process.env.POOL_TOKEN_ADDRESS) as `0x${string}` | undefined;

/**
 * Transfer intent submitted by the signer EOA (Path B).
 */
export interface TransferIntent {
  /** User's main address (signer EOA) */
  userAddress: string;
  /** Recipient address for the transfer */
  recipient: string;
  /** Amount in 18-decimal USD string */
  amount: string;
  /** Token address (defaults to DEFAULT_TOKEN_ADDRESS / USDC) */
  token?: string;
  /** Optional signature proving the signer authorized this intent */
  signature?: string;
}

export interface AutoSignResult {
  approved: boolean;
  /** Unlink relay ID (on approval) */
  relayId?: string;
  /** Reason for rejection or pending_review */
  reason?: string;
  /** "approved" | "pending_review" | "rejected" */
  status: "approved" | "pending_review" | "rejected";
  /** Remaining balance after debit (on approval) */
  newBalance?: string;
}

/**
 * Process a Path B transfer intent.
 *
 * Validates guardrails, then either:
 * - Executes via Unlink withdrawal (approved)
 * - Marks for manual review (pending_review)
 */
export async function processProposal(
  prisma: PrismaClient,
  publicClient: PublicClient,
  unlink: Unlink,
  intent: TransferIntent,
): Promise<AutoSignResult> {
  const { userAddress, recipient, amount, token } = intent;

  const tokenAddress = (token ?? DEFAULT_TOKEN_ADDRESS) as
    | `0x${string}`
    | undefined;
  if (!tokenAddress) {
    return {
      approved: false,
      status: "rejected",
      reason: "No token address provided and DEFAULT_TOKEN_ADDRESS not set",
    };
  }

  // 1. Verify user exists
  const user = await prisma.user.findUnique({
    where: { address: userAddress.toLowerCase() },
  });

  if (!user) {
    const result: AutoSignResult = {
      approved: false,
      status: "rejected",
      reason: "User not registered",
    };
    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, null, {
      userAddress,
      recipient,
      amount,
      reason: result.reason,
    });
    return result;
  }

  // 2. Policy validation (balance, velocity, $10k cap, on-chain limits)
  const validation = await validateSpendIntent(prisma, publicClient, {
    userAddress,
    amount,
  });

  if (!validation.allowed) {
    // Policy rejected → mark as pending_review for manual confirmation
    // (phone call, email, or other out-of-band verification)
    const result: AutoSignResult = {
      approved: false,
      status: "pending_review",
      reason: validation.reason,
    };

    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, user.id, {
      userAddress,
      recipient,
      amount,
      validation,
      status: "pending_review",
      reason: result.reason,
    });

    return result;
  }

  // 3. Approved — execute via Unlink withdrawal
  try {
    // Convert 18-decimal USD amount to token units (e.g., 6 decimals for USDC)
    const amountBn = BigInt(amount);
    const decimalDiff = 18 - DEFAULT_TOKEN_DECIMALS;
    const tokenAmount =
      decimalDiff >= 0
        ? amountBn / 10n ** BigInt(decimalDiff)
        : amountBn * 10n ** BigInt(-decimalDiff);

    // Debit user ledger first (atomic — will throw if insufficient)
    let newBalance: string;
    try {
      newBalance = await debitBalance(
        prisma,
        user.id,
        "usd",
        amount,
        undefined,
        `Path B transfer to ${recipient}`,
      );
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return {
          approved: false,
          status: "pending_review",
          reason: "Insufficient deposited balance",
        };
      }
      throw err;
    }

    // Execute Unlink withdrawal to recipient
    const result = await unlink.withdraw({
      withdrawals: [
        {
          token: tokenAddress,
          amount: tokenAmount,
          recipient: recipient as `0x${string}`,
        },
      ],
    });

    const signResult: AutoSignResult = {
      approved: true,
      status: "approved",
      relayId: result.relayId,
      newBalance,
    };

    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_APPROVED, user.id, {
      userAddress,
      recipient,
      amount,
      tokenAmount: tokenAmount.toString(),
      tokenAddress,
      relayId: result.relayId,
      newBalance,
    });

    return signResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Withdrawal failed — mark as pending_review (ledger was already debited,
    // will need manual reconciliation or refund)
    const result: AutoSignResult = {
      approved: false,
      status: "pending_review",
      reason: `Withdrawal failed: ${message}`,
    };

    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, user.id, {
      userAddress,
      recipient,
      amount,
      error: message,
      reason: result.reason,
      note: "Ledger may have been debited — needs reconciliation",
    });

    return result;
  }
}
