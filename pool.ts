/**
 * JIT (Just-In-Time) pool funding + high-water mark sweep.
 *
 * Periodically checks the Unlink pool balance for the configured token.
 * - If balance drops below the low-water mark, auto top-ups from a funder wallet.
 * - If balance exceeds the high-water mark, sweeps excess to M1 Safe.
 *
 * Supports two modes:
 * - FIXED: Uses POOL_LOW_WATER_MARK / POOL_HIGH_WATER_MARK env vars directly.
 * - DYNAMIC (default when LOW/HIGH are 0/unset): Computes thresholds from total
 *   system deposits (pool + M1 Safe). target = total * POOL_TARGET_PERCENT / 100,
 *   low = target - POOL_BUFFER_AMOUNT, high = target + POOL_BUFFER_AMOUNT.
 *
 * Env vars:
 *   POOL_FUNDER_PRIVATE_KEY   - Private key of the funder wallet (0x-prefixed)
 *   POOL_TOKEN_ADDRESS        - ERC-20 token address to monitor
 *   POOL_LOW_WATER_MARK       - Fixed low-water threshold (token units, string). 0 = dynamic mode.
 *   POOL_TOP_UP_AMOUNT        - Amount to deposit on each top-up (token units, string)
 *   POOL_HIGH_WATER_MARK      - Fixed high-water threshold (token units, string). 0 = dynamic mode.
 *   POOL_SWEEP_RECIPIENT      - Address to sweep excess to (defaults to SAFE_ADDRESS)
 *   POOL_CHECK_INTERVAL_MS    - Check interval in ms (default: 60000)
 *   POOL_TARGET_PERCENT       - Dynamic: target pool % of total deposits (default: 10)
 *   POOL_BUFFER_AMOUNT        - Dynamic: buffer around target (token units, default: 5000000000 = 5k USDC)
 */

import type { PrismaClient } from "@prisma/client";
import type { Unlink } from "@unlink-xyz/node";
import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AUDIT_ACTIONS, logAudit } from "./audit.js";

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
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
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const FUNDER_KEY = process.env.POOL_FUNDER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const TOKEN_ADDRESS = process.env.POOL_TOKEN_ADDRESS as
  | `0x${string}`
  | undefined;
const LOW_WATER_MARK = BigInt(process.env.POOL_LOW_WATER_MARK ?? "0");
const TOP_UP_AMOUNT = BigInt(process.env.POOL_TOP_UP_AMOUNT ?? "0");
const HIGH_WATER_MARK = BigInt(process.env.POOL_HIGH_WATER_MARK ?? "0");
const SWEEP_RECIPIENT = (process.env.POOL_SWEEP_RECIPIENT ??
  process.env.SAFE_ADDRESS) as `0x${string}` | undefined;
const CHECK_INTERVAL = Number(process.env.POOL_CHECK_INTERVAL_MS ?? 60_000);

// Dynamic threshold config (used when LOW_WATER_MARK and HIGH_WATER_MARK are both 0/unset)
const POOL_TARGET_PERCENT = Number(process.env.POOL_TARGET_PERCENT ?? 10); // integer, basis 100
const POOL_BUFFER_AMOUNT = BigInt(
  process.env.POOL_BUFFER_AMOUNT ?? "5000000000",
); // 5k USDC (6 decimals)
const USE_DYNAMIC_THRESHOLDS = LOW_WATER_MARK === 0n && HIGH_WATER_MARK === 0n;

let isTopping = false;
let isSweeping = false;
let lastTopUpTime: Date | null = null;
let lastSweepTime: Date | null = null;

export interface PoolStatus {
  tokenAddress: string | null;
  currentBalance: string;
  lowWaterMark: string;
  highWaterMark: string;
  topUpAmount: string;
  lastTopUpTime: string | null;
  lastSweepTime: string | null;
  isHealthy: boolean;
  funderConfigured: boolean;
  sweepRecipient: string | null;
  // Dynamic threshold fields
  totalDeposits: string | null;
  target: string | null;
  targetPercent: number;
  bufferAmount: string;
  dynamicMode: boolean;
}

/**
 * Computes dynamic pool thresholds based on total system deposits
 * (Unlink pool + M1 Safe on-chain balance).
 *
 * target = totalDeposits * TARGET_PERCENT / 100
 * lowWaterMark = target - BUFFER  (floored at 0)
 * highWaterMark = target + BUFFER
 */
async function computeDynamicThresholds(
  unlink: Unlink,
  publicClient: PublicClient,
): Promise<{
  lowWaterMark: bigint;
  highWaterMark: bigint;
  totalDeposits: bigint;
  target: bigint;
}> {
  const poolBalance = TOKEN_ADDRESS
    ? await unlink.getBalance(TOKEN_ADDRESS)
    : 0n;

  let m1Balance = 0n;
  if (TOKEN_ADDRESS && SWEEP_RECIPIENT) {
    m1Balance = (await publicClient.readContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [SWEEP_RECIPIENT],
    })) as bigint;
  }

  const totalDeposits = poolBalance + m1Balance;
  const target = (totalDeposits * BigInt(POOL_TARGET_PERCENT)) / 100n;
  const lowWaterMark =
    target > POOL_BUFFER_AMOUNT ? target - POOL_BUFFER_AMOUNT : 0n;
  const highWaterMark = target + POOL_BUFFER_AMOUNT;

  return { lowWaterMark, highWaterMark, totalDeposits, target };
}

/**
 * Returns current pool status without triggering a top-up or sweep.
 * If publicClient is provided and dynamic mode is active, computes dynamic thresholds.
 */
export async function getPoolStatus(
  unlink: Unlink,
  publicClient?: PublicClient,
): Promise<PoolStatus> {
  let currentBalance = 0n;

  if (TOKEN_ADDRESS) {
    try {
      currentBalance = await unlink.getBalance(TOKEN_ADDRESS);
    } catch {
      // Balance may be 0 or token not tracked yet
    }
  }

  let effectiveLow = LOW_WATER_MARK;
  let effectiveHigh = HIGH_WATER_MARK;
  let totalDeposits: bigint | null = null;
  let target: bigint | null = null;

  if (USE_DYNAMIC_THRESHOLDS && publicClient && TOKEN_ADDRESS) {
    try {
      const dynamic = await computeDynamicThresholds(unlink, publicClient);
      effectiveLow = dynamic.lowWaterMark;
      effectiveHigh = dynamic.highWaterMark;
      totalDeposits = dynamic.totalDeposits;
      target = dynamic.target;
    } catch (err) {
      console.warn(
        `[pool] Failed to compute dynamic thresholds, using fixed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    tokenAddress: TOKEN_ADDRESS ?? null,
    currentBalance: currentBalance.toString(),
    lowWaterMark: effectiveLow.toString(),
    highWaterMark: effectiveHigh.toString(),
    topUpAmount: TOP_UP_AMOUNT.toString(),
    lastTopUpTime: lastTopUpTime?.toISOString() ?? null,
    lastSweepTime: lastSweepTime?.toISOString() ?? null,
    isHealthy: currentBalance >= effectiveLow,
    funderConfigured: !!FUNDER_KEY && !!TOKEN_ADDRESS,
    sweepRecipient: SWEEP_RECIPIENT ?? null,
    totalDeposits: totalDeposits?.toString() ?? null,
    target: target?.toString() ?? null,
    targetPercent: POOL_TARGET_PERCENT,
    bufferAmount: POOL_BUFFER_AMOUNT.toString(),
    dynamicMode: USE_DYNAMIC_THRESHOLDS,
  };
}

/**
 * Starts periodic pool balance monitoring.
 * If balance < lowWaterMark, deposits topUpAmount from funder wallet.
 * If balance > highWaterMark, sweeps excess to M1 Safe.
 *
 * In dynamic mode (no fixed LOW/HIGH_WATER_MARK), thresholds are recomputed
 * each cycle based on total system deposits (pool + M1 Safe).
 */
export function startPoolMonitor(
  prisma: PrismaClient,
  unlink: Unlink,
  externalPublicClient?: PublicClient,
): void {
  if (!FUNDER_KEY || !TOKEN_ADDRESS) {
    console.warn(
      "[pool] POOL_FUNDER_PRIVATE_KEY or POOL_TOKEN_ADDRESS not set — pool monitor disabled.",
    );
    return;
  }

  if (
    !USE_DYNAMIC_THRESHOLDS &&
    (LOW_WATER_MARK <= 0n || TOP_UP_AMOUNT <= 0n)
  ) {
    console.warn(
      "[pool] POOL_LOW_WATER_MARK or POOL_TOP_UP_AMOUNT not set and dynamic mode inactive — pool monitor disabled.",
    );
    return;
  }

  if (USE_DYNAMIC_THRESHOLDS && TOP_UP_AMOUNT <= 0n) {
    console.warn("[pool] POOL_TOP_UP_AMOUNT not set — pool monitor disabled.");
    return;
  }

  const funderAccount = privateKeyToAccount(FUNDER_KEY);
  const rpcUrl = process.env.RPC_URL!;
  const chainId = Number(process.env.CHAIN_ID ?? 10143);

  const chain = {
    id: chainId,
    name: "monad-testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;

  const walletClient = createWalletClient({
    account: funderAccount,
    transport: http(rpcUrl),
    chain,
  });

  const publicClient =
    externalPublicClient ??
    createPublicClient({
      transport: http(rpcUrl),
      chain,
    });

  if (USE_DYNAMIC_THRESHOLDS) {
    console.log(
      `[pool] Starting monitor (DYNAMIC mode) — checking every ${CHECK_INTERVAL / 1000}s, ` +
        `target: ${POOL_TARGET_PERCENT}% of total, buffer: ${POOL_BUFFER_AMOUNT}, ` +
        `top-up: ${TOP_UP_AMOUNT}, funder: ${funderAccount.address}`,
    );
  } else {
    console.log(
      `[pool] Starting monitor (FIXED mode) — checking every ${CHECK_INTERVAL / 1000}s, ` +
        `low-water: ${LOW_WATER_MARK}, high-water: ${HIGH_WATER_MARK || "disabled"}, ` +
        `top-up: ${TOP_UP_AMOUNT}, funder: ${funderAccount.address}`,
    );
  }

  const check = async () => {
    if (isTopping || isSweeping) return;

    try {
      const balance = await unlink.getBalance(TOKEN_ADDRESS!);

      // Resolve thresholds for this cycle
      let effectiveLow = LOW_WATER_MARK;
      let effectiveHigh = HIGH_WATER_MARK;

      if (USE_DYNAMIC_THRESHOLDS) {
        try {
          const dynamic = await computeDynamicThresholds(
            unlink,
            publicClient as PublicClient,
          );
          effectiveLow = dynamic.lowWaterMark;
          effectiveHigh = dynamic.highWaterMark;
          console.log(
            `[pool] Dynamic thresholds — total: ${dynamic.totalDeposits}, target: ${dynamic.target}, ` +
              `low: ${effectiveLow}, high: ${effectiveHigh}, pool: ${balance}`,
          );
        } catch (err) {
          console.warn(
            `[pool] Dynamic threshold computation failed, skipping cycle: ${err instanceof Error ? err.message : err}`,
          );
          return;
        }
      }

      // ─── Low-water mark: top-up from funder ───────────────────────
      if (effectiveLow > 0n && balance < effectiveLow) {
        console.log(
          `[pool] Balance ${balance} below low-water ${effectiveLow} — initiating top-up`,
        );

        isTopping = true;

        // 1. Prepare deposit via Unlink
        const deposit = await unlink.deposit({
          depositor: funderAccount.address,
          deposits: [{ token: TOKEN_ADDRESS!, amount: TOP_UP_AMOUNT }],
        });

        // 2. Ensure ERC-20 allowance for the deposit contract
        const spender = deposit.to as `0x${string}`;
        const allowance = await publicClient.readContract({
          address: TOKEN_ADDRESS!,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [funderAccount.address, spender],
        });

        if ((allowance as bigint) < TOP_UP_AMOUNT) {
          console.log(
            `[pool] Approving ${spender} to spend token (current allowance: ${allowance})`,
          );
          const approveTx = await walletClient.writeContract({
            address: TOKEN_ADDRESS!,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [spender, maxUint256],
          });
          await publicClient.waitForTransactionReceipt({ hash: approveTx });
          console.log(`[pool] Approval tx confirmed: ${approveTx}`);
        }

        // 3. Submit deposit tx from funder wallet
        const txHash = await walletClient.sendTransaction({
          to: deposit.to as `0x${string}`,
          value: BigInt(deposit.value),
          data: deposit.calldata as `0x${string}`,
        });

        // 4. Confirm deposit
        await unlink.confirmDeposit(deposit.relayId);

        lastTopUpTime = new Date();

        console.log(
          `[pool] Top-up complete — relayId: ${deposit.relayId}, txHash: ${txHash}`,
        );

        await logAudit(prisma, AUDIT_ACTIONS.POOL_TOPUP, null, {
          tokenAddress: TOKEN_ADDRESS,
          amount: TOP_UP_AMOUNT.toString(),
          txHash,
          relayId: deposit.relayId,
          previousBalance: balance.toString(),
        });

        return; // Don't sweep in the same cycle as a top-up
      }

      // ─── High-water mark: sweep excess to M1 Safe ─────────────────
      if (effectiveHigh > 0n && SWEEP_RECIPIENT && balance > effectiveHigh) {
        const excess = balance - effectiveHigh;

        console.log(
          `[pool] Balance ${balance} above high-water ${effectiveHigh} — sweeping ${excess} to ${SWEEP_RECIPIENT}`,
        );

        isSweeping = true;

        const result = await unlink.withdraw({
          withdrawals: [
            {
              token: TOKEN_ADDRESS!,
              amount: excess,
              recipient: SWEEP_RECIPIENT,
            },
          ],
        });

        lastSweepTime = new Date();

        console.log(
          `[pool] Sweep complete — relayId: ${result.relayId}, excess: ${excess}`,
        );

        await logAudit(prisma, AUDIT_ACTIONS.POOL_SWEEP, null, {
          tokenAddress: TOKEN_ADDRESS,
          amount: excess.toString(),
          recipient: SWEEP_RECIPIENT,
          relayId: result.relayId,
          previousBalance: balance.toString(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pool] Monitor check failed: ${message}`);

      const action = isSweeping
        ? AUDIT_ACTIONS.POOL_SWEEP_FAILED
        : AUDIT_ACTIONS.POOL_TOPUP_FAILED;

      await logAudit(prisma, action, null, {
        tokenAddress: TOKEN_ADDRESS,
        error: message,
      });
    } finally {
      isTopping = false;
      isSweeping = false;
    }
  };

  check();
  setInterval(check, CHECK_INTERVAL);
}
