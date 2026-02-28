/**
 * SpendAuthorized event watcher.
 *
 * Polls eth_getLogs on an interval for SpendAuthorized events emitted by
 * the contracts stored in the WatchedContract table. Persists new events
 * to SpendAuthorizedEvent and tracks the last processed block in Meta.
 *
 * Env vars:
 *   RPC_URL                   - HTTP JSON-RPC endpoint
 *   WATCHER_POLL_INTERVAL_MS  - Poll interval in ms (default: 10000)
 *   WATCHER_START_BLOCK       - Block to start from on first run (default: latest)
 */

import { PrismaClient } from "@prisma/client";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";

const SPEND_AUTHORIZED = parseAbiItem(
  "event SpendAuthorized(address indexed m2, address indexed eoa, uint256 amount, bytes32 recipientHash, uint8 transferType, uint256 nonce)"
);

const META_KEY = "last_processed_block";
const POLL_INTERVAL = Number(process.env.WATCHER_POLL_INTERVAL_MS ?? 10_000);

export function startWatcher(prisma: PrismaClient): void {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.warn("[watcher] RPC_URL not set — event watcher disabled.");
    return;
  }

  const client = createPublicClient({ transport: http(rpcUrl) });

  console.log(
    `[watcher] Starting — polling every ${POLL_INTERVAL / 1000}s via ${rpcUrl}`
  );

  const poll = async () => {
    try {
      // Load watched contracts from DB
      const contracts = await prisma.watchedContract.findMany({
        select: { address: true },
      });

      if (contracts.length === 0) {
        return; // nothing to watch yet
      }

      const addresses = contracts.map((c) => c.address as Address);

      // Resolve block range
      const latestBlock = await client.getBlockNumber();

      const fromBlock = await resolveFromBlock(prisma, latestBlock);
      if (fromBlock > latestBlock) return;

      const logs = await client.getLogs({
        address: addresses,
        event: SPEND_AUTHORIZED,
        fromBlock,
        toBlock: latestBlock,
      });

      if (logs.length > 0) {
        console.log(
          `[watcher] ${logs.length} SpendAuthorized event(s) in blocks ${fromBlock}–${latestBlock}`
        );

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
                contractAddress: log.address,
                m2: log.args.m2!,
                eoa: log.args.eoa!,
                amount: log.args.amount!.toString(),
                recipientHash: log.args.recipientHash!,
                transferType: log.args.transferType!,
                nonce: log.args.nonce!.toString(),
              },
              update: {},
            })
          )
        );
      }

      // Advance the cursor
      await prisma.meta.upsert({
        where: { key: META_KEY },
        create: { key: META_KEY, value: (latestBlock + 1n).toString() },
        update: { value: (latestBlock + 1n).toString() },
      });
    } catch (err) {
      console.error("[watcher] Poll error:", err instanceof Error ? err.message : err);
    }
  };

  // Run immediately then on interval
  poll();
  setInterval(poll, POLL_INTERVAL);
}

async function resolveFromBlock(
  prisma: PrismaClient,
  latestBlock: bigint
): Promise<bigint> {
  const meta = await prisma.meta.findUnique({ where: { key: META_KEY } });

  if (meta) return BigInt(meta.value);

  // First run — use WATCHER_START_BLOCK env or fall back to latest
  const startEnv = process.env.WATCHER_START_BLOCK;
  return startEnv ? BigInt(startEnv) : latestBlock;
}
