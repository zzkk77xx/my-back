/**
 * SpendAuthorized event watcher + withdrawal executor.
 *
 * Each poll cycle:
 *   1. Fetches SpendAuthorized logs from watched contracts.
 *   2. Persists new events with withdrawalStatus = "pending".
 *   3. Processes all "pending" events:
 *        a. Resolves recipientHash → recipient address from RecipientMapping.
 *        b. Converts the 18-decimal USD amount to the token's native decimals.
 *        c. Calls unlink.withdraw() and stores the relayId.
 *        d. Marks the event "done" on success, "failed" on error,
 *           or "no_recipient" if no mapping is registered yet.
 *
 * Env vars:
 *   RPC_URL                   - HTTP JSON-RPC endpoint (required)
 *   WATCHER_POLL_INTERVAL_MS  - Poll interval in ms (default: 10000)
 *   WATCHER_START_BLOCK       - Block to start from on first run (default: latest)
 */

import { PrismaClient } from "@prisma/client";
import type { Unlink } from "@unlink-xyz/node";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";

const SPEND_AUTHORIZED = parseAbiItem(
  "event SpendAuthorized(address indexed m2, address indexed eoa, uint256 amount, bytes32 recipientHash, uint8 transferType, uint256 nonce)"
);

const META_KEY = "last_processed_block";
const POLL_INTERVAL = Number(process.env.WATCHER_POLL_INTERVAL_MS ?? 10_000);

// ─── Public entry point ───────────────────────────────────────────────────────

export function startWatcher(prisma: PrismaClient, unlink: Unlink): void {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.warn("[watcher] RPC_URL not set — event watcher disabled.");
    return;
  }

  const viemClient = createPublicClient({ transport: http(rpcUrl) });

  console.log(
    `[watcher] Starting — polling every ${POLL_INTERVAL / 1000}s via ${rpcUrl}`
  );

  const poll = async () => {
    try {
      await fetchAndPersistNewEvents(prisma, viemClient);
      await processPendingWithdrawals(prisma, unlink);
    } catch (err) {
      console.error(
        "[watcher] Poll error:",
        err instanceof Error ? err.message : err
      );
    }
  };

  poll();
  setInterval(poll, POLL_INTERVAL);
}

// ─── Step 1: fetch on-chain logs and persist new events ──────────────────────

async function fetchAndPersistNewEvents(
  prisma: PrismaClient,
  viemClient: ReturnType<typeof createPublicClient>
) {
  const contracts = await prisma.watchedContract.findMany({
    select: { address: true },
  });

  if (contracts.length === 0) return;

  const addresses = contracts.map((c) => c.address as Address);
  const latestBlock = await viemClient.getBlockNumber();
  const fromBlock = await resolveFromBlock(prisma, latestBlock);

  if (fromBlock > latestBlock) return;

  const logs = await viemClient.getLogs({
    address: addresses,
    event: SPEND_AUTHORIZED,
    fromBlock,
    toBlock: latestBlock,
  });

  if (logs.length > 0) {
    console.log(
      `[watcher] ${logs.length} SpendAuthorized event(s) in blocks ${fromBlock}–${latestBlock}`
    );

    // Persist new events (upsert = idempotent; update:{} = no-op if already exists)
    await prisma.$transaction(
      logs.map((log) =>
        prisma.spendAuthorizedEvent.upsert({
          where: {
            txHash_logIndex: {
              txHash: log.transactionHash!,
              logIndex: log.logIndex!,
            },
          },
          create: {
            blockNumber: log.blockNumber!,
            txHash: log.transactionHash!,
            logIndex: log.logIndex!,
            contractAddress: log.address.toLowerCase(),
            m2: log.args.m2!.toLowerCase(),
            eoa: log.args.eoa!.toLowerCase(),
            amount: log.args.amount!.toString(),
            recipientHash: log.args.recipientHash!,
            transferType: log.args.transferType!,
            nonce: log.args.nonce!.toString(),
            withdrawalStatus: "pending",
          },
          update: {}, // no-op — already stored, don't overwrite withdrawal state
        })
      )
    );
  }

  // Advance cursor to next block
  await prisma.meta.upsert({
    where: { key: META_KEY },
    create: { key: META_KEY, value: (latestBlock + 1n).toString() },
    update: { value: (latestBlock + 1n).toString() },
  });
}

// ─── Step 2: execute withdrawals for all pending events ───────────────────────

async function processPendingWithdrawals(
  prisma: PrismaClient,
  unlink: Unlink
) {
  const pending = await prisma.spendAuthorizedEvent.findMany({
    where: { withdrawalStatus: "pending" },
    orderBy: { nonce: "asc" },
  });

  if (pending.length === 0) return;

  // Load contract configs (tokenAddress + tokenDecimals) and recipient mappings
  const [contracts, mappings] = await Promise.all([
    prisma.watchedContract.findMany(),
    prisma.recipientMapping.findMany({
      where: { hash: { in: pending.map((e) => e.recipientHash) } },
    }),
  ]);

  const contractByAddress = Object.fromEntries(
    contracts.map((c) => [c.address.toLowerCase(), c])
  );
  const recipientByHash = Object.fromEntries(
    mappings.map((m) => [m.hash.toLowerCase(), m.address])
  );

  for (const event of pending) {
    // Mark as processing immediately to prevent concurrent re-runs
    await prisma.spendAuthorizedEvent.update({
      where: { id: event.id },
      data: { withdrawalStatus: "processing" },
    });

    const contract = contractByAddress[event.contractAddress.toLowerCase()];
    const recipient = recipientByHash[event.recipientHash.toLowerCase()];

    if (!recipient) {
      console.warn(
        `[watcher] No recipient mapping for hash ${event.recipientHash} (event id=${event.id}) — skipping`
      );
      await prisma.spendAuthorizedEvent.update({
        where: { id: event.id },
        data: { withdrawalStatus: "no_recipient" },
      });
      continue;
    }

    if (!contract) {
      // Shouldn't happen, but guard anyway
      await prisma.spendAuthorizedEvent.update({
        where: { id: event.id },
        data: {
          withdrawalStatus: "failed",
          withdrawalError: `Contract config not found for ${event.contractAddress}`,
        },
      });
      continue;
    }

    try {
      // Convert 18-decimal USD amount → token native decimals
      // e.g. USDC (6 dec): amount / 10^(18-6) = amount / 10^12
      const usdAmount = BigInt(event.amount);
      const decimalDiff = 18 - contract.tokenDecimals;
      const tokenAmount =
        decimalDiff >= 0
          ? usdAmount / 10n ** BigInt(decimalDiff)
          : usdAmount * 10n ** BigInt(-decimalDiff);

      console.log(
        `[watcher] Withdrawing ${tokenAmount} (token units) of ${contract.tokenAddress} ` +
          `→ ${recipient} for event id=${event.id}`
      );

      const result = await unlink.withdraw({
        withdrawals: [
          {
            token: contract.tokenAddress as `0x${string}`,
            amount: tokenAmount,
            recipient: recipient as `0x${string}`,
          },
        ],
      });

      await prisma.spendAuthorizedEvent.update({
        where: { id: event.id },
        data: {
          withdrawalStatus: "done",
          withdrawalRelayId: result.relayId,
        },
      });

      console.log(
        `[watcher] Withdrawal submitted for event id=${event.id} — relayId: ${result.relayId}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[watcher] Withdrawal failed for event id=${event.id}: ${message}`
      );
      await prisma.spendAuthorizedEvent.update({
        where: { id: event.id },
        data: { withdrawalStatus: "failed", withdrawalError: message },
      });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveFromBlock(
  prisma: PrismaClient,
  latestBlock: bigint
): Promise<bigint> {
  const meta = await prisma.meta.findUnique({ where: { key: META_KEY } });
  if (meta) return BigInt(meta.value);

  const startEnv = process.env.WATCHER_START_BLOCK;
  return startEnv ? BigInt(startEnv) : latestBlock;
}
