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
import { decodeFunctionData, type PublicClient } from "viem";
import { AUDIT_ACTIONS, logAudit } from "./audit.js";
import { AUTO_SIGN_LIMIT_USD, validateSpendIntent } from "./policy.js";

// Minimal ERC-20 ABI for decoding transfer/approve calldata
const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

// Default USDC decimals — used to convert token-unit amount to 18-decimal USD
const USDC_DECIMALS = Number(process.env.DEFAULT_TOKEN_DECIMALS ?? 6);

/**
 * Try to extract the ERC-20 transfer amount from calldata.
 * Returns the amount in 18-decimal USD, or null if not a transfer/approve call.
 */
function extractErc20Amount(data: string): bigint | null {
  if (!data || data === "0x" || data.length < 10) return null;

  try {
    const { functionName, args } = decodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      data: data as `0x${string}`,
    });

    if (functionName === "transfer" || functionName === "approve") {
      const tokenAmount = args[1] as bigint;
      // Convert token units → 18-decimal USD (assuming 1:1 stablecoin)
      const decimalDiff = 18 - USDC_DECIMALS;
      return decimalDiff >= 0
        ? tokenAmount * 10n ** BigInt(decimalDiff)
        : tokenAmount / 10n ** BigInt(-decimalDiff);
    }
  } catch {
    // Not a recognized ERC-20 call — that's fine
  }

  return null;
}

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
  proposal: SafeTxProposal,
): Promise<AutoSignResult> {
  const { safeAddress, safeTx, userSignature, userAddress } = proposal;

  // 1. Verify user exists and safeAddress matches
  const user = await prisma.user.findUnique({
    where: { address: userAddress.toLowerCase() },
  });

  if (!user) {
    const result: AutoSignResult = {
      approved: false,
      reason: "User not registered",
    };
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

  // 2. Determine the effective USD amount to validate.
  //    - Native value transfers: use safeTx.value directly (already 18-dec)
  //    - ERC-20 transfer/approve: decode calldata, convert token units → 18-dec USD
  const txValue = BigInt(safeTx.value);
  const erc20Amount = extractErc20Amount(safeTx.data);
  const effectiveAmount = erc20Amount ?? txValue; // prefer ERC-20 if present

  // 3. Amount cap check
  if (effectiveAmount > AUTO_SIGN_LIMIT_USD) {
    const result: AutoSignResult = {
      approved: false,
      reason: "Transaction amount exceeds auto-sign limit",
    };
    await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, user.id, {
      userAddress,
      safeAddress,
      txValue: safeTx.value,
      erc20Amount: erc20Amount?.toString() ?? null,
      effectiveAmount: effectiveAmount.toString(),
      reason: result.reason,
    });
    return result;
  }

  // 4. Policy validation (balance, velocity, on-chain limits)
  if (effectiveAmount > 0n) {
    const validation = await validateSpendIntent(prisma, publicClient, {
      userAddress,
      amount: effectiveAmount.toString(),
    });

    if (!validation.allowed) {
      const result: AutoSignResult = {
        approved: false,
        reason: validation.reason,
      };
      await logAudit(prisma, AUDIT_ACTIONS.AUTO_SIGN_REJECTED, user.id, {
        userAddress,
        safeAddress,
        erc20Amount: erc20Amount?.toString() ?? null,
        effectiveAmount: effectiveAmount.toString(),
        validation,
        reason: result.reason,
      });
      return result;
    }
  }

  // 5–8. Co-sign and execute
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
      new EthSafeSignature(userAddress, userSignature),
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
