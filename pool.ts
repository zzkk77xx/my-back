/**
 * JIT (Just-In-Time) pool funding + high-water mark sweep.
 *
 * Periodically checks the Unlink pool balance for the configured token.
 * - If balance drops below the low-water mark, auto top-ups from a funder wallet.
 * - If balance exceeds the high-water mark, sweeps excess to M1 Safe.
 *
 * Env vars:
 *   POOL_FUNDER_PRIVATE_KEY   - Private key of the funder wallet (0x-prefixed)
 *   POOL_TOKEN_ADDRESS        - ERC-20 token address to monitor
 *   POOL_LOW_WATER_MARK       - Balance threshold that triggers top-up (token units, string)
 *   POOL_TOP_UP_AMOUNT        - Amount to deposit on each top-up (token units, string)
 *   POOL_HIGH_WATER_MARK      - Balance threshold that triggers sweep to M1 (token units, string)
 *   POOL_SWEEP_RECIPIENT      - Address to sweep excess to (defaults to SAFE_ADDRESS)
 *   POOL_CHECK_INTERVAL_MS    - Check interval in ms (default: 60000)
 */

import type { PrismaClient } from "@prisma/client";
import type { Unlink } from "@unlink-xyz/node";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AUDIT_ACTIONS, logAudit } from "./audit.js";

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
}

/**
 * Returns current pool status without triggering a top-up or sweep.
 */
export async function getPoolStatus(unlink: Unlink): Promise<PoolStatus> {
  let currentBalance = 0n;

  if (TOKEN_ADDRESS) {
    try {
      currentBalance = await unlink.getBalance(TOKEN_ADDRESS);
    } catch {
      // Balance may be 0 or token not tracked yet
    }
  }

  return {
    tokenAddress: TOKEN_ADDRESS ?? null,
    currentBalance: currentBalance.toString(),
    lowWaterMark: LOW_WATER_MARK.toString(),
    highWaterMark: HIGH_WATER_MARK.toString(),
    topUpAmount: TOP_UP_AMOUNT.toString(),
    lastTopUpTime: lastTopUpTime?.toISOString() ?? null,
    lastSweepTime: lastSweepTime?.toISOString() ?? null,
    isHealthy: currentBalance >= LOW_WATER_MARK,
    funderConfigured: !!FUNDER_KEY && !!TOKEN_ADDRESS,
    sweepRecipient: SWEEP_RECIPIENT ?? null,
  };
}

/**
 * Starts periodic pool balance monitoring.
 * If balance < lowWaterMark, deposits topUpAmount from funder wallet.
 * If balance > highWaterMark, sweeps excess to M1 Safe.
 */
export function startPoolMonitor(prisma: PrismaClient, unlink: Unlink): void {
  if (!FUNDER_KEY || !TOKEN_ADDRESS) {
    console.warn(
      "[pool] POOL_FUNDER_PRIVATE_KEY or POOL_TOKEN_ADDRESS not set — pool monitor disabled.",
    );
    return;
  }

  if (LOW_WATER_MARK <= 0n || TOP_UP_AMOUNT <= 0n) {
    console.warn(
      "[pool] POOL_LOW_WATER_MARK or POOL_TOP_UP_AMOUNT not set — pool monitor disabled.",
    );
    return;
  }

  const funderAccount = privateKeyToAccount(FUNDER_KEY);
  const rpcUrl = process.env.RPC_URL!;
  const chainId = Number(process.env.CHAIN_ID ?? 10143);

  const walletClient = createWalletClient({
    account: funderAccount,
    transport: http(rpcUrl),
    chain: {
      id: chainId,
      name: "monad-testnet",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
  });

  console.log(
    `[pool] Starting monitor — checking every ${CHECK_INTERVAL / 1000}s, ` +
      `low-water: ${LOW_WATER_MARK}, high-water: ${HIGH_WATER_MARK || "disabled"}, ` +
      `top-up: ${TOP_UP_AMOUNT}, funder: ${funderAccount.address}`,
  );

  const check = async () => {
    if (isTopping || isSweeping) return;

    try {
      const balance = await unlink.getBalance(TOKEN_ADDRESS!);

      // ─── Low-water mark: top-up from funder ───────────────────────
      if (balance < LOW_WATER_MARK) {
        console.log(
          `[pool] Balance ${balance} below low-water ${LOW_WATER_MARK} — initiating top-up`,
        );

        isTopping = true;

        // 1. Prepare deposit via Unlink
        const deposit = await unlink.deposit({
          depositor: funderAccount.address,
          deposits: [{ token: TOKEN_ADDRESS!, amount: TOP_UP_AMOUNT }],
        });

        // 2. Submit deposit tx from funder wallet
        const txHash = await walletClient.sendTransaction({
          to: deposit.to as `0x${string}`,
          value: BigInt(deposit.value),
          data: deposit.calldata as `0x${string}`,
        });

        // 3. Confirm deposit
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
      if (
        HIGH_WATER_MARK > 0n &&
        SWEEP_RECIPIENT &&
        balance > HIGH_WATER_MARK
      ) {
        const excess = balance - HIGH_WATER_MARK;

        console.log(
          `[pool] Balance ${balance} above high-water ${HIGH_WATER_MARK} — sweeping ${excess} to ${SWEEP_RECIPIENT}`,
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
