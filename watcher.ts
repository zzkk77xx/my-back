/**
 * SpendAuthorized event watcher + withdrawal executor.
 *
 * Each poll cycle:
 *   1. Fetches SpendAuthorized events from Envio indexer (with RPC fallback).
 *   2. Persists new events with withdrawalStatus = "pending".
 *   3. Processes eligible pending events:
 *        a. Resolves recipientHash → recipient address from RecipientMapping.
 *        b. Detects internal transfers (M2 → M2) and settles via ledger only.
 *        c. Converts the 18-decimal USD amount to the token's native decimals.
 *        d. Calls unlink.withdraw() and stores the relayId.
 *        e. Marks the event "done" on success, "failed" on error,
 *           or "no_recipient" if no mapping is registered yet.
 *   4. Retries failed events up to MAX_RETRIES with exponential backoff.
 *      After max retries, moves to "dead_letter" status.
 *
 * Env vars:
 *   RPC_URL                   - HTTP JSON-RPC endpoint (required)
 *   ENVIO_GRAPHQL_URL         - Envio indexer GraphQL endpoint (optional, enables Envio mode)
 *   WATCHER_POLL_INTERVAL_MS  - Poll interval in ms (default: 10000)
 *   WATCHER_START_BLOCK       - Block to start from on first run (default: latest)
 *   DECORRELATION_MIN_MS      - Min random delay before execution (default: 2000)
 *   DECORRELATION_MAX_MS      - Max random delay before execution (default: 30000)
 */

import { PrismaClient } from "@prisma/client";
import type { Unlink } from "@unlink-xyz/node";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { AUDIT_ACTIONS, logAudit } from "./audit.js";
import {
  creditBalance,
  debitBalance,
  InsufficientBalanceError,
} from "./ledger.js";

const SPEND_AUTHORIZED = parseAbiItem(
  "event SpendAuthorized(address indexed m2, address indexed eoa, uint256 amount, bytes32 recipientHash, uint8 transferType, uint256 nonce)",
);

const META_KEY = "last_processed_block";
const POLL_INTERVAL = Number(process.env.WATCHER_POLL_INTERVAL_MS ?? 3_000);
const ENVIO_GRAPHQL_URL = process.env.ENVIO_GRAPHQL_URL;

// Retry logic
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 30_000; // 30s base, doubles each retry

// Timing decorrelation — random delay between auth event and execution
// const DECORRELATION_MIN_MS = Number(process.env.DECORRELATION_MIN_MS ?? 2_000);
// const DECORRELATION_MAX_MS = Number(process.env.DECORRELATION_MAX_MS ?? 30_000);

// Exported for health check
export let lastPollAt: Date | null = null;

// function randomDelay(): number {
//   return (
//     DECORRELATION_MIN_MS +
//     Math.random() * (DECORRELATION_MAX_MS - DECORRELATION_MIN_MS)
//   );
// }

// ─── Public entry point ───────────────────────────────────────────────────────

export function startWatcher(prisma: PrismaClient, unlink: Unlink): void {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.warn("[watcher] RPC_URL not set — event watcher disabled.");
    return;
  }

  const viemClient = createPublicClient({ transport: http(rpcUrl) });

  if (ENVIO_GRAPHQL_URL) {
    console.log(
      `[watcher] Starting — polling every ${POLL_INTERVAL / 1000}s via Envio (${ENVIO_GRAPHQL_URL})`,
    );
  } else {
    console.log(
      `[watcher] Starting — polling every ${POLL_INTERVAL / 1000}s via RPC (${rpcUrl})`,
    );
    console.warn(
      "[watcher] ENVIO_GRAPHQL_URL not set — using direct getLogs (may hit Monad block range limits)",
    );
  }

  const poll = async () => {
    try {
      await fetchAndPersistNewEvents(prisma, viemClient);
      await processEligibleEvents(prisma, unlink);
    } catch (err) {
      console.error(
        "[watcher] Poll error:",
        err instanceof Error ? err.message : err,
      );
    }
    lastPollAt = new Date();
  };

  poll();
  setInterval(poll, POLL_INTERVAL);
}

// ─── Step 1: fetch events and persist ────────────────────────────────────────

async function fetchAndPersistNewEvents(
  prisma: PrismaClient,
  viemClient: ReturnType<typeof createPublicClient>,
) {
  const contracts = await prisma.watchedContract.findMany({
    select: { address: true },
  });

  if (contracts.length === 0) return;

  if (ENVIO_GRAPHQL_URL) {
    await fetchViaEnvio(prisma, viemClient);
  } else {
    await fetchViaRpc(
      prisma,
      viemClient,
      contracts.map((c) => c.address as Address),
    );
  }
}

// ─── Envio GraphQL source ────────────────────────────────────────────────────

interface EnvioSpendAuthorized {
  srcAddress: string;
  m2: string;
  eoa: string;
  amount: string;
  recipientHash: string;
  transferType: number;
  nonce: string;
  blockNumber: string;
  txHash: string;
  logIndex: number;
}

async function fetchViaEnvio(
  prisma: PrismaClient,
  viemClient: ReturnType<typeof createPublicClient>,
) {
  const latestBlock = await viemClient.getBlockNumber();
  const fromBlock = await resolveFromBlock(prisma, latestBlock);

  if (fromBlock > latestBlock) return;

  const query = `
    query SpendAuthorizedEvents($sinceBlock: numeric!) {
      SpendAuthorized(
        where: { blockNumber: { _gt: $sinceBlock } }
        order_by: { blockNumber: asc, logIndex: asc }
      ) {
        srcAddress
        m2
        eoa
        amount
        recipientHash
        transferType
        nonce
        blockNumber
        txHash
        logIndex
      }
    }
  `;

  let events: EnvioSpendAuthorized[];

  try {
    const res = await fetch(ENVIO_GRAPHQL_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { sinceBlock: (fromBlock - 1n).toString() },
      }),
    });

    if (!res.ok) {
      throw new Error(`Envio HTTP ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as {
      data?: { SpendAuthorized: EnvioSpendAuthorized[] };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`Envio GraphQL: ${json.errors[0].message}`);
    }

    events = json.data?.SpendAuthorized ?? [];
  } catch (err) {
    console.error(
      "[watcher] Envio query failed, skipping this cycle:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (events.length > 0) {
    console.log(
      `[watcher] ${events.length} SpendAuthorized event(s) from Envio (blocks ${fromBlock}–${latestBlock})`,
    );

    await prisma.$transaction(
      events.map((e) =>
        prisma.spendAuthorizedEvent.upsert({
          where: {
            txHash_logIndex: {
              txHash: e.txHash,
              logIndex: e.logIndex,
            },
          },
          create: {
            blockNumber: BigInt(e.blockNumber),
            txHash: e.txHash,
            logIndex: e.logIndex,
            contractAddress: e.srcAddress.toLowerCase(),
            m2: e.m2.toLowerCase(),
            eoa: e.eoa.toLowerCase(),
            amount: e.amount,
            recipientHash: e.recipientHash,
            transferType: e.transferType,
            nonce: e.nonce,
            withdrawalStatus: "pending",
            scheduledAt: new Date(),
          },
          update: {},
        }),
      ),
    );
  }

  await prisma.meta.upsert({
    where: { key: META_KEY },
    create: { key: META_KEY, value: (latestBlock + 1n).toString() },
    update: { value: (latestBlock + 1n).toString() },
  });
}

// ─── RPC getLogs fallback ────────────────────────────────────────────────────

async function fetchViaRpc(
  prisma: PrismaClient,
  viemClient: ReturnType<typeof createPublicClient>,
  addresses: Address[],
) {
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
      `[watcher] ${logs.length} SpendAuthorized event(s) in blocks ${fromBlock}–${latestBlock}`,
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
            contractAddress: log.address.toLowerCase(),
            m2: log.args.m2!.toLowerCase(),
            eoa: log.args.eoa!.toLowerCase(),
            amount: log.args.amount!.toString(),
            recipientHash: log.args.recipientHash!,
            transferType: log.args.transferType!,
            nonce: log.args.nonce!.toString(),
            withdrawalStatus: "pending",
            scheduledAt: new Date(),
          },
          update: {},
        }),
      ),
    );
  }

  await prisma.meta.upsert({
    where: { key: META_KEY },
    create: { key: META_KEY, value: (latestBlock + 1n).toString() },
    update: { value: (latestBlock + 1n).toString() },
  });
}

// ─── Step 2: process eligible events (pending + retryable) ───────────────────

async function processEligibleEvents(prisma: PrismaClient, unlink: Unlink) {
  const now = new Date();

  // Fetch pending + retryable events
  const events = await prisma.spendAuthorizedEvent.findMany({
    where: {
      OR: [
        {
          withdrawalStatus: "pending",
        },
        {
          withdrawalStatus: "failed",
          retryCount: { lt: MAX_RETRIES },
          nextRetryAt: { lte: now },
        },
      ],
    },
    orderBy: { nonce: "asc" },
  });

  if (events.length === 0) return;

  // Load contract configs (tokenAddress + tokenDecimals) and recipient mappings
  const [contracts, mappings] = await Promise.all([
    prisma.watchedContract.findMany(),
    prisma.recipientMapping.findMany({
      where: { hash: { in: events.map((e) => e.recipientHash) } },
    }),
  ]);

  const contractByAddress = Object.fromEntries(
    contracts.map((c) => [c.address.toLowerCase(), c]),
  );
  const recipientByHash = Object.fromEntries(
    mappings.map((m) => [m.hash.toLowerCase(), m.address]),
  );

  for (const event of events) {
    const isRetry = event.withdrawalStatus === "failed";

    // Mark as processing immediately to prevent concurrent re-runs
    await prisma.spendAuthorizedEvent.update({
      where: { id: event.id },
      data: { withdrawalStatus: "processing" },
    });

    if (isRetry) {
      await logAudit(prisma, AUDIT_ACTIONS.WITHDRAWAL_RETRY, null, {
        eventId: event.id,
        retryCount: event.retryCount + 1,
      });
    }

    const contract = contractByAddress[event.contractAddress.toLowerCase()];
    const recipient = recipientByHash[event.recipientHash.toLowerCase()];

    if (!recipient) {
      console.warn(
        `[watcher] No recipient mapping for hash ${event.recipientHash} (event id=${event.id}) — skipping`,
      );
      await prisma.spendAuthorizedEvent.update({
        where: { id: event.id },
        data: { withdrawalStatus: "no_recipient" },
      });
      continue;
    }

    if (!contract) {
      await handleFailure(
        prisma,
        event,
        `Contract config not found for ${event.contractAddress}`,
      );
      continue;
    }

    // ─── Internal transfer detection ─────────────────────────────────
    // If the recipient is another M2 Safe within the bank, settle via
    // ledger (debit sender, credit receiver) — no Unlink movement needed.
    const recipientUser = await prisma.user.findFirst({
      where: { safeAddress: recipient.toLowerCase() },
    });

    const senderUser = await prisma.user.findFirst({
      where: { spendInteractorAddress: event.contractAddress.toLowerCase() },
    });

    if (recipientUser) {
      console.log(
        `[watcher] Internal transfer detected: event id=${event.id} → user ${recipientUser.id} (${recipientUser.safeAddress})`,
      );

      // Debit sender (best-effort)
      if (senderUser) {
        try {
          await debitBalance(
            prisma,
            senderUser.id,
            "usd",
            event.amount,
            `internal_transfer_event_${event.id}`,
            `internal transfer to user ${recipientUser.id}`,
          );
        } catch (debitErr) {
          if (debitErr instanceof InsufficientBalanceError) {
            console.warn(
              `[watcher] Insufficient ledger balance for sender user ${senderUser.id} — internal transfer still proceeding`,
            );
          } else {
            console.error(
              `[watcher] Ledger debit error for event id=${event.id}:`,
              debitErr,
            );
          }
        }
      }

      // Credit receiver
      await creditBalance(
        prisma,
        recipientUser.id,
        "usd",
        event.amount,
        `internal_transfer_event_${event.id}`,
        `internal transfer from user ${senderUser?.id ?? "unknown"}`,
      );

      await prisma.spendAuthorizedEvent.update({
        where: { id: event.id },
        data: {
          withdrawalStatus: "done",
          withdrawalRelayId: "internal_transfer",
        },
      });

      await logAudit(
        prisma,
        AUDIT_ACTIONS.INTERNAL_TRANSFER,
        senderUser?.id ?? null,
        {
          eventId: event.id,
          senderUserId: senderUser?.id,
          recipientUserId: recipientUser.id,
          amount: event.amount,
          recipientSafe: recipientUser.safeAddress,
        },
      );

      continue;
    }

    // ─── External withdrawal via Unlink ──────────────────────────────
    try {
      // Convert 18-decimal USD amount → token native decimals
      const usdAmount = BigInt(event.amount);
      const decimalDiff = 18 - contract.tokenDecimals;
      const tokenAmount =
        decimalDiff >= 0
          ? usdAmount / 10n ** BigInt(decimalDiff)
          : usdAmount * 10n ** BigInt(-decimalDiff);

      console.log(
        `[watcher] Withdrawing ${tokenAmount} (token units) of ${contract.tokenAddress} ` +
          `→ ${recipient} for event id=${event.id}`,
      );

      // Sync Unlink state to pick up latest on-chain note status
      await unlink.sync();

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
        `[watcher] Withdrawal submitted for event id=${event.id} — relayId: ${result.relayId}`,
      );

      // Debit user balance (best-effort — on-chain limits are the real backstop)
      if (senderUser) {
        try {
          await debitBalance(
            prisma,
            senderUser.id,
            "usd",
            event.amount,
            result.relayId,
            `withdrawal event id=${event.id}`,
          );
        } catch (debitErr) {
          if (debitErr instanceof InsufficientBalanceError) {
            console.warn(
              `[watcher] Insufficient ledger balance for user ${senderUser.id} — withdrawal still executed (on-chain limits are authoritative)`,
            );
          } else {
            console.error(
              `[watcher] Ledger debit error for event id=${event.id}:`,
              debitErr instanceof Error ? debitErr.message : debitErr,
            );
          }
        }
      }

      await logAudit(
        prisma,
        AUDIT_ACTIONS.WITHDRAWAL_EXECUTED,
        senderUser?.id ?? null,
        {
          eventId: event.id,
          contractAddress: event.contractAddress,
          amount: event.amount,
          recipient,
          relayId: result.relayId,
          tokenAddress: contract.tokenAddress,
          tokenAmount: tokenAmount.toString(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[watcher] Withdrawal failed for event id=${event.id}: ${message}`,
      );
      await handleFailure(prisma, event, message);
    }
  }
}

// ─── Retry / DLQ handling ────────────────────────────────────────────────────

async function handleFailure(
  prisma: PrismaClient,
  event: {
    id: number;
    retryCount: number;
    contractAddress: string;
    amount: string;
  },
  errorMessage: string,
) {
  const newRetryCount = event.retryCount + 1;

  if (newRetryCount >= MAX_RETRIES) {
    // Move to dead letter queue
    await prisma.spendAuthorizedEvent.update({
      where: { id: event.id },
      data: {
        withdrawalStatus: "dead_letter",
        withdrawalError: errorMessage,
        retryCount: newRetryCount,
      },
    });

    console.error(
      `[watcher] Event id=${event.id} moved to dead letter queue after ${MAX_RETRIES} retries`,
    );

    await logAudit(prisma, AUDIT_ACTIONS.WITHDRAWAL_DLQ, null, {
      eventId: event.id,
      contractAddress: event.contractAddress,
      amount: event.amount,
      error: errorMessage,
      retryCount: newRetryCount,
    });
  } else {
    // Schedule retry with exponential backoff
    const backoffMs = RETRY_BASE_MS * Math.pow(2, event.retryCount);
    const nextRetryAt = new Date(Date.now() + backoffMs);

    await prisma.spendAuthorizedEvent.update({
      where: { id: event.id },
      data: {
        withdrawalStatus: "failed",
        withdrawalError: errorMessage,
        retryCount: newRetryCount,
        nextRetryAt,
      },
    });

    console.warn(
      `[watcher] Event id=${event.id} failed (retry ${newRetryCount}/${MAX_RETRIES}), ` +
        `next retry at ${nextRetryAt.toISOString()}`,
    );

    await logAudit(prisma, AUDIT_ACTIONS.WITHDRAWAL_FAILED, null, {
      eventId: event.id,
      contractAddress: event.contractAddress,
      amount: event.amount,
      error: errorMessage,
      retryCount: newRetryCount,
      nextRetryAt: nextRetryAt.toISOString(),
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveFromBlock(
  prisma: PrismaClient,
  latestBlock: bigint,
): Promise<bigint> {
  const meta = await prisma.meta.findUnique({ where: { key: META_KEY } });
  if (meta) return BigInt(meta.value);

  const startEnv = process.env.WATCHER_START_BLOCK;
  return startEnv ? BigInt(startEnv) : latestBlock;
}
