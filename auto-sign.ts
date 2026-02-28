/**
 * Bank auto-sign service.
 *
 * User proposes a Safe tx (pre-signed with their key), bank validates guardrails
 * via the policy engine, co-signs with the admin key to reach 2/2 threshold,
 * and executes on-chain.
 *
 * All approve/reject decisions are recorded to the audit log.
 */

import type { PrismaClient } from "@prisma/client";
import Safe, { EthSafeSignature } from "@safe-global/protocol-kit";
import type { PublicClient } from "viem";
import { AUDIT_ACTIONS, logAudit } from "./audit.js";
import { AUTO_SIGN_LIMIT_USD, validateSpendIntent } from "./policy.js";

export interface SafeTxProposal {
  safeAddress: string;
  safeTx: {
    to: string;
    value: string;
    data: string;
    operation: number;
    safeTxGas: string;
    baseGas: string;
    gasPrice: string;
    gasToken: string;
    refundReceiver: string;
    nonce: number;
  };
  userSignature: string;
  userAddress: string;
}

export interface AutoSignResult {
  approved: boolean;
  txHash?: string;
  reason?: string;
}

export async function processProposal(
  prisma: PrismaClient,
  publicClient: PublicClient,
  adminPrivateKey: string,
  rpcUrl: string,
  proposal: SafeTxProposal
): Promise<AutoSignResult> {
  const { safeAddress, safeTx, userSignature, userAddress } = proposal;

  // 1. Verify user exists and safeAddress matches
  const user = await prisma.user.findUnique({
    where: { address: userAddress.toLowerCase() },
  });

  if (!user) {
    const result: AutoSignResult = { approved: false, reason: "User not registered" };
    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, null, {
      userAddress,
      safeAddress,
      reason: result.reason,
    });
    return result;
  }

  if (user.safeAddress.toLowerCase() !== safeAddress.toLowerCase()) {
    const result: AutoSignResult = {
      approved: false,
      reason: "Safe address does not match user's registered Safe",
    };
    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, user.id, {
      userAddress,
      safeAddress,
      expectedSafe: user.safeAddress,
      reason: result.reason,
    });
    return result;
  }

  // 2. Value cap check (raw tx value — prevent draining native token)
  const txValue = BigInt(safeTx.value);
  if (txValue > AUTO_SIGN_LIMIT_USD) {
    const result: AutoSignResult = {
      approved: false,
      reason: "Transaction value exceeds auto-sign limit",
    };
    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, user.id, {
      userAddress,
      safeAddress,
      txValue: safeTx.value,
      reason: result.reason,
    });
    return result;
  }

  // 3. Policy validation (balance + on-chain limits)
  // Only run if tx has a meaningful value (spending tx)
  if (txValue > 0n) {
    const validation = await validateSpendIntent(prisma, publicClient, {
      userAddress,
      amount: safeTx.value,
    });

    if (!validation.allowed) {
      const result: AutoSignResult = {
        approved: false,
        reason: validation.reason,
      };
      await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, user.id, {
        userAddress,
        safeAddress,
        validation,
        reason: result.reason,
      });
      return result;
    }
  }

  // 4–7. Co-sign and execute
  try {
    const safeSdk = await Safe.init({
      provider: rpcUrl,
      signer: adminPrivateKey,
      safeAddress,
    });

    const safeTransaction = await safeSdk.createTransaction({
      transactions: [
        {
          to: safeTx.to,
          value: safeTx.value,
          data: safeTx.data,
          operation: safeTx.operation,
        },
      ],
    });

    // Apply the user's pre-computed signature
    safeTransaction.addSignature(
      new EthSafeSignature(userAddress, userSignature)
    );

    // Admin co-signs
    const signedTx = await safeSdk.signTransaction(safeTransaction);

    // Execute — reaches 2/2 threshold
    const execResult = await safeSdk.executeTransaction(signedTx);

    const result: AutoSignResult = {
      approved: true,
      txHash: execResult.hash,
    };

    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_APPROVED, user.id, {
      userAddress,
      safeAddress,
      txHash: execResult.hash,
      to: safeTx.to,
      value: safeTx.value,
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: AutoSignResult = {
      approved: false,
      reason: `Execution failed: ${message}`,
    };
    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, user.id, {
      userAddress,
      safeAddress,
      error: message,
      reason: result.reason,
    });
    return result;
  }
}
