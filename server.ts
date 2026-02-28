/**
 * Unlink HTTP API
 *
 * Exposes deposit/withdraw operations over Express.
 * Wallet state is derived from UNLINK_MNEMONIC on every boot (in-memory).
 * Event data and watched contracts are persisted to PlanetScale via Prisma.
 *
 * Env vars:
 *   UNLINK_MNEMONIC           - 24-word BIP-39 mnemonic (required)
 *   SAFE_ADDRESS              - Default withdrawal recipient (0x-prefixed)
 *   DATABASE_URL              - PostgreSQL connection string (required)
 *   RPC_URL                   - Monad testnet HTTP RPC for event watching
 *   PORT                      - HTTP port (default: 3000)
 *   WATCHER_POLL_INTERVAL_MS  - Event poll interval in ms (default: 10000)
 *   WATCHER_START_BLOCK       - Block to start from on first run
 */

import { PrismaClient } from "@prisma/client";
import { initUnlink, type Unlink } from "@unlink-xyz/node";
import cors from "cors";
import express, { type Request, type Response } from "express";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requirePrivyAuth } from "./auth.js";
import { processProposal, type SafeTxProposal } from "./auto-sign.js";
import { AUDIT_ACTIONS, logAudit, queryAuditLogs } from "./audit.js";
import { creditBalance, getAllBalances } from "./ledger.js";
import { validateSpendIntent } from "./policy.js";
import { getPoolStatus, startPoolMonitor } from "./pool.js";
import { SPEND_INTERACTOR_ABI, deployUserSafe } from "./safe.js";
import { lastPollAt, startWatcher } from "./watcher.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const MNEMONIC = process.env.UNLINK_MNEMONIC;
if (!MNEMONIC) throw new Error("UNLINK_MNEMONIC env var is required");

const DEFAULT_RECIPIENT = process.env.SAFE_ADDRESS as `0x${string}` | undefined;
const PORT = Number(process.env.PORT ?? 3000);
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const RPC_URL = process.env.RPC_URL!;
const DEFAULT_TOKEN_ADDRESS = (process.env.DEFAULT_TOKEN_ADDRESS ??
  process.env.POOL_TOKEN_ADDRESS) as `0x${string}` | undefined;
const DEFAULT_TOKEN_DECIMALS = Number(process.env.DEFAULT_TOKEN_DECIMALS ?? 6);

// viem clients reused for EOA registration calls
const _chain = {
  id: CHAIN_ID,
  name: "monad-testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const _adminAccount = process.env.ADMIN_PRIVATE_KEY
  ? privateKeyToAccount(process.env.ADMIN_PRIVATE_KEY as `0x${string}`)
  : undefined;

const _walletClient = _adminAccount
  ? createWalletClient({
      account: _adminAccount,
      transport: http(RPC_URL),
      chain: _chain,
    })
  : undefined;

const _publicClient = createPublicClient({
  transport: http(RPC_URL),
  chain: _chain,
});

// ─── Singletons ───────────────────────────────────────────────────────────────

const prisma = new PrismaClient();
let unlink: Unlink;

async function initWallet() {
  unlink = await initUnlink({
    chain: "monad-testnet",
    setup: false,
    sync: false,
  });
  await unlink.seed.importMnemonic(MNEMONIC!);
  await unlink.accounts.create();
  await unlink.sync();
  const account = await unlink.accounts.getActive();
  console.log("Wallet ready. Active account:", account!.address);
}

// Pending deposit metadata — keyed by relayId, populated by /deposit/prepare,
// consumed by /deposit/confirm to auto-credit the user's ledger balance.
// In-memory is fine: Unlink wallet state is also ephemeral (re-derived on boot).
interface PendingDeposit {
  depositor: string; // user EOA
  token: string; // ERC-20 address
  amount: string; // token-unit amount string
}
const pendingDeposits = new Map<string, PendingDeposit>();

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const startedAt = Date.now();

// ─── GET /health ─────────────────────────────────────────────────────────────

app.get("/health", async (_req: Request, res: Response) => {
  const components: Record<string, { status: string; [k: string]: unknown }> =
    {};

  // Database check
  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    components.database = { status: "up", latencyMs: Date.now() - dbStart };
  } catch (err) {
    components.database = {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Watcher check
  const pendingCount = await prisma.spendAuthorizedEvent
    .count({
      where: { withdrawalStatus: "pending" },
    })
    .catch(() => -1);

  const dlqCount = await prisma.spendAuthorizedEvent
    .count({
      where: { withdrawalStatus: "dead_letter" },
    })
    .catch(() => -1);

  components.watcher = {
    status: lastPollAt ? "up" : "starting",
    lastPollAt: lastPollAt?.toISOString() ?? null,
    pendingEvents: pendingCount,
    deadLetterEvents: dlqCount,
  };

  // Pool check
  try {
    const poolStatus = await getPoolStatus(unlink);
    components.pool = {
      status: "up",
      isHealthy: poolStatus.isHealthy,
      currentBalance: poolStatus.currentBalance,
    };
  } catch (err) {
    components.pool = {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Unlink check
  try {
    const account = await unlink.accounts.getActive();
    components.unlink = { status: account ? "up" : "down" };
  } catch (err) {
    components.unlink = {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Overall status
  const dbUp = components.database.status === "up";
  const unlinkUp = components.unlink.status === "up";
  const overallStatus =
    dbUp && unlinkUp ? "healthy" : dbUp || unlinkUp ? "degraded" : "unhealthy";

  const statusCode = overallStatus === "unhealthy" ? 503 : 200;

  res.status(statusCode).json({
    status: overallStatus,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    components,
  });
});

// ─── POST /users/register ─────────────────────────────────────────────────────
//
// Body: { address: "0x..." }
// Idempotent: returns the existing Safe address if the user is already registered.

app.post(
  "/users/register",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const { address } = req.body as { address: string };

    if (!address) {
      res.status(400).json({ error: "address is required" });
      return;
    }

    const normalized = address.toLowerCase();

    // Return early if already registered
    const existing = await prisma.user.findUnique({
      where: { address: normalized },
    });
    if (existing) {
      res.json({ safeAddress: existing.safeAddress, created: false });
      return;
    }

    const { safeAddress, spendInteractorAddress } =
      await deployUserSafe(address);

    const user = await prisma.user.create({
      data: {
        address: normalized,
        safeAddress: safeAddress.toLowerCase(),
        spendInteractorAddress: spendInteractorAddress.toLowerCase(),
      },
    });

    // Auto-register SpendInteractor as a WatchedContract so the watcher
    // picks up SpendAuthorized events for this user.
    if (DEFAULT_TOKEN_ADDRESS) {
      await prisma.watchedContract.upsert({
        where: { address: spendInteractorAddress.toLowerCase() },
        create: {
          address: spendInteractorAddress.toLowerCase(),
          tokenAddress: DEFAULT_TOKEN_ADDRESS.toLowerCase(),
          tokenDecimals: DEFAULT_TOKEN_DECIMALS,
          label: `user:${normalized}`,
        },
        update: {},
      });
    }

    // Auto-register RecipientMapping so withdrawals to this user resolve.
    // Hash convention: keccak256(abi.encodePacked(address))
    const recipientHash = keccak256(
      encodePacked(["address"], [address as `0x${string}`]),
    );
    await prisma.recipientMapping.upsert({
      where: { hash: recipientHash },
      create: {
        hash: recipientHash,
        address: normalized,
        label: `user:${normalized}`,
      },
      update: {},
    });

    res.status(201).json({ safeAddress: user.safeAddress, created: true });
  },
);

// ─── POST /users/:userAddress/eoas ────────────────────────────────────────────
//
// Registers an EOA on the user's SpendInteractor.
// Body: { eoa: "0x...", dailyLimit: "1000000000000000000", allowedTypes: [0, 1] }
// Admin calls registerEOA() directly (SpendInteractor owner = admin).

app.post(
  "/users/:userAddress/eoas",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const { userAddress } = req.params;
    const { eoa, dailyLimit, allowedTypes } = req.body as {
      eoa: string;
      dailyLimit: string;
      allowedTypes: number[];
    };

    if (!eoa || !dailyLimit || !allowedTypes) {
      res
        .status(400)
        .json({ error: "eoa, dailyLimit, and allowedTypes are required" });
      return;
    }

    if (!_walletClient || !_adminAccount) {
      res.status(500).json({ error: "ADMIN_PRIVATE_KEY not configured" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { address: userAddress.toLowerCase() },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const txHash = await _walletClient.writeContract({
      address: user.spendInteractorAddress as `0x${string}`,
      abi: SPEND_INTERACTOR_ABI,
      functionName: "registerEOA",
      args: [eoa as `0x${string}`, BigInt(dailyLimit), allowedTypes],
    });

    await _publicClient.waitForTransactionReceipt({ hash: txHash });

    res.status(201).json({
      txHash,
      eoa,
      spendInteractorAddress: user.spendInteractorAddress,
    });
  },
);

// ─── GET /users/:userAddress/eoas ─────────────────────────────────────────────

app.get("/users/:userAddress/eoas", async (req: Request, res: Response) => {
  const { userAddress } = req.params;

  const user = await prisma.user.findUnique({
    where: { address: userAddress.toLowerCase() },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const eoas = await _publicClient.readContract({
    address: user.spendInteractorAddress as `0x${string}`,
    abi: SPEND_INTERACTOR_ABI,
    functionName: "getRegisteredEOAs",
  });

  res.json({ eoas, spendInteractorAddress: user.spendInteractorAddress });
});

// ─── DELETE /users/:userAddress/eoas/:eoa ─────────────────────────────────────

app.delete(
  "/users/:userAddress/eoas/:eoa",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const { userAddress, eoa } = req.params;

    if (!_walletClient) {
      res.status(500).json({ error: "ADMIN_PRIVATE_KEY not configured" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { address: userAddress.toLowerCase() },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const txHash = await _walletClient.writeContract({
      address: user.spendInteractorAddress as `0x${string}`,
      abi: SPEND_INTERACTOR_ABI,
      functionName: "revokeEOA",
      args: [eoa as `0x${string}`],
    });

    await _publicClient.waitForTransactionReceipt({ hash: txHash });

    res.json({ txHash, eoa });
  },
);

// ─── GET /account ─────────────────────────────────────────────────────────────

app.get("/account", async (_req: Request, res: Response) => {
  const account = await unlink.accounts.getActive();
  res.json({ address: account!.address });
});

// ─── GET /balances ────────────────────────────────────────────────────────────

app.get("/balances", async (_req: Request, res: Response) => {
  const raw = await unlink.getBalances();
  const balances = Object.fromEntries(
    Object.entries(raw).map(([token, amount]) => [token, amount.toString()]),
  );
  res.json(balances);
});

// ─── POST /deposit/prepare ────────────────────────────────────────────────────
//
// Body: { depositor: "0x...", token: "0x...", amount: "1000000" }
// Returns: { to, calldata, value, relayId }
//   → client submits the tx, then calls /deposit/confirm

app.post("/deposit/prepare", async (req: Request, res: Response) => {
  const { depositor, token, amount } = req.body as {
    depositor: string;
    token: string;
    amount: string;
  };

  if (!depositor || !token || !amount) {
    res
      .status(400)
      .json({ error: "depositor, token, and amount are required" });
    return;
  }

  const deposit = await unlink.deposit({
    depositor: depositor as `0x${string}`,
    deposits: [{ token: token as `0x${string}`, amount: BigInt(amount) }],
  });

  // Store metadata so /deposit/confirm can auto-credit the user's ledger
  pendingDeposits.set(deposit.relayId, {
    depositor: depositor.toLowerCase(),
    token: token.toLowerCase(),
    amount,
  });

  res.json({
    to: deposit.to,
    calldata: deposit.calldata,
    value: deposit.value.toString(),
    relayId: deposit.relayId,
  });
});

// ─── POST /deposit/confirm ────────────────────────────────────────────────────
//
// Body: { relayId: "..." }

app.post("/deposit/confirm", async (req: Request, res: Response) => {
  const { relayId } = req.body as { relayId: string };

  if (!relayId) {
    res.status(400).json({ error: "relayId is required" });
    return;
  }

  await unlink.confirmDeposit(relayId);

  // Auto-credit user's internal ledger balance if we have deposit metadata
  const pending = pendingDeposits.get(relayId);
  let creditedBalance: string | undefined;

  if (pending) {
    pendingDeposits.delete(relayId);

    const user = await prisma.user.findUnique({
      where: { address: pending.depositor },
    });

    if (user) {
      // Convert token-unit amount → 18-decimal USD (assuming 1:1 stablecoin)
      // e.g. USDC 1000000 (6 dec) → 1000000000000000000 (18 dec)
      const tokenDecimals = DEFAULT_TOKEN_DECIMALS;
      const decimalDiff = 18 - tokenDecimals;
      const usdAmount =
        decimalDiff >= 0
          ? BigInt(pending.amount) * 10n ** BigInt(decimalDiff)
          : BigInt(pending.amount) / 10n ** BigInt(-decimalDiff);

      creditedBalance = await creditBalance(
        prisma,
        user.id,
        "usd",
        usdAmount.toString(),
        relayId,
        `pool deposit via ${pending.token}`,
      );
    }
  }

  // 90/10 split: sweep 90% of deposit to M1 Safe, keep 10% in Unlink as liquidity
  let sweepRelayId: string | undefined;
  if (pending && DEFAULT_RECIPIENT) {
    const depositTokenAmount = BigInt(pending.amount);
    const sweepAmount = (depositTokenAmount * 90n) / 100n;

    if (sweepAmount > 0n) {
      try {
        const sweepResult = await unlink.withdraw({
          withdrawals: [
            {
              token: pending.token as `0x${string}`,
              amount: sweepAmount,
              recipient: DEFAULT_RECIPIENT,
            },
          ],
        });
        sweepRelayId = sweepResult.relayId;

        console.log(
          `[deposit] Swept 90% (${sweepAmount}) to M1 Safe ${DEFAULT_RECIPIENT}, relay: ${sweepRelayId}`,
        );

        await logAudit(prisma, AUDIT_ACTIONS.POOL_SWEEP, null, {
          trigger: "deposit_90_10_split",
          tokenAddress: pending.token,
          depositAmount: pending.amount,
          sweepAmount: sweepAmount.toString(),
          retainedAmount: (depositTokenAmount - sweepAmount).toString(),
          recipient: DEFAULT_RECIPIENT,
          relayId: sweepRelayId,
          depositor: pending.depositor,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[deposit] 90/10 sweep failed: ${msg}`);
        await logAudit(prisma, AUDIT_ACTIONS.POOL_SWEEP_FAILED, null, {
          trigger: "deposit_90_10_split",
          error: msg,
          tokenAddress: pending.token,
          depositAmount: pending.amount,
        });
      }
    }
  }

  res.json({
    ok: true,
    creditedBalance: creditedBalance ?? null,
    sweepRelayId: sweepRelayId ?? null,
  });
});

// ─── POST /withdraw ───────────────────────────────────────────────────────────
//
// Body: { token: "0x...", amount: "1000000", recipient?: "0x..." }
// Returns: { relayId } — poll /relay/:relayId for status

app.post("/withdraw", async (req: Request, res: Response) => {
  const { token, amount, recipient } = req.body as {
    token: string;
    amount: string;
    recipient?: string;
  };

  if (!token || !amount) {
    res.status(400).json({ error: "token and amount are required" });
    return;
  }

  const to = (recipient ?? DEFAULT_RECIPIENT) as `0x${string}` | undefined;
  if (!to) {
    res.status(400).json({
      error: "recipient is required (or set SAFE_ADDRESS env var)",
    });
    return;
  }

  const result = await unlink.withdraw({
    withdrawals: [
      { token: token as `0x${string}`, amount: BigInt(amount), recipient: to },
    ],
  });

  res.json({ relayId: result.relayId });
});

// ─── GET /relay/:relayId ──────────────────────────────────────────────────────

app.get("/relay/:relayId", async (req: Request, res: Response) => {
  const { relayId } = req.params;
  const status = await unlink.getTxStatus(relayId);
  res.json({ state: status.state, txHash: status.txHash ?? null });
});

// ─── GET /events ──────────────────────────────────────────────────────────────
//
// Query params: ?contract=0x...  ?limit=50

app.get("/events", async (req: Request, res: Response) => {
  const contract = req.query.contract as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);

  const events = await prisma.spendAuthorizedEvent.findMany({
    where: contract ? { contractAddress: contract.toLowerCase() } : undefined,
    orderBy: { blockNumber: "desc" },
    take: limit,
  });

  // Serialize BigInt fields
  res.json(
    events.map((e) => ({
      ...e,
      blockNumber: e.blockNumber.toString(),
    })),
  );
});

// ─── GET /contracts ───────────────────────────────────────────────────────────

app.get("/contracts", async (_req: Request, res: Response) => {
  const contracts = await prisma.watchedContract.findMany({
    orderBy: { createdAt: "asc" },
  });
  res.json(contracts);
});

// ─── POST /contracts ──────────────────────────────────────────────────────────
//
// Body: { address: "0x...", tokenAddress: "0x...", tokenDecimals?: 6, label?: "..." }

app.post("/contracts", async (req: Request, res: Response) => {
  const { address, tokenAddress, tokenDecimals, label } = req.body as {
    address: string;
    tokenAddress: string;
    tokenDecimals?: number;
    label?: string;
  };

  if (!address || !tokenAddress) {
    res.status(400).json({ error: "address and tokenAddress are required" });
    return;
  }

  const contract = await prisma.watchedContract.upsert({
    where: { address: address.toLowerCase() },
    create: {
      address: address.toLowerCase(),
      tokenAddress: tokenAddress.toLowerCase(),
      tokenDecimals: tokenDecimals ?? 6,
      label,
    },
    update: {
      tokenAddress: tokenAddress.toLowerCase(),
      tokenDecimals: tokenDecimals ?? 6,
      label,
    },
  });

  res.status(201).json(contract);
});

// ─── GET /recipients ──────────────────────────────────────────────────────────

app.get("/recipients", async (_req: Request, res: Response) => {
  const mappings = await prisma.recipientMapping.findMany({
    orderBy: { createdAt: "asc" },
  });
  res.json(mappings);
});

// ─── POST /recipients ─────────────────────────────────────────────────────────
//
// Body: { hash: "0x...", address: "0x...", label?: "..." }
// hash = keccak256 of the recipient identifier, as passed to authorizeSpend()

app.post("/recipients", async (req: Request, res: Response) => {
  const { hash, address, label } = req.body as {
    hash: string;
    address: string;
    label?: string;
  };

  if (!hash || !address) {
    res.status(400).json({ error: "hash and address are required" });
    return;
  }

  const mapping = await prisma.recipientMapping.upsert({
    where: { hash: hash.toLowerCase() },
    create: { hash: hash.toLowerCase(), address: address.toLowerCase(), label },
    update: { address: address.toLowerCase(), label },
  });

  res.status(201).json(mapping);
});

// ─── POST /recipients/by-address ──────────────────────────────────────────────
//
// Convenience: takes just an address and auto-computes the recipientHash via
// keccak256(encodePacked(address)), matching Solidity's convention.
// Body: { address: "0x...", label?: "..." }

app.post("/recipients/by-address", async (req: Request, res: Response) => {
  const { address, label } = req.body as { address: string; label?: string };

  if (!address) {
    res.status(400).json({ error: "address is required" });
    return;
  }

  const hash = keccak256(encodePacked(["address"], [address as `0x${string}`]));

  const mapping = await prisma.recipientMapping.upsert({
    where: { hash },
    create: { hash, address: address.toLowerCase(), label },
    update: { address: address.toLowerCase(), label },
  });

  res.status(201).json(mapping);
});

// ─── DELETE /recipients/:hash ─────────────────────────────────────────────────

app.delete("/recipients/:hash", async (req: Request, res: Response) => {
  const { hash } = req.params;

  await prisma.recipientMapping.delete({
    where: { hash: hash.toLowerCase() },
  });

  res.json({ ok: true });
});

// ─── DELETE /contracts/:address ───────────────────────────────────────────────

app.delete("/contracts/:address", async (req: Request, res: Response) => {
  const { address } = req.params;

  await prisma.watchedContract.delete({
    where: { address: address.toLowerCase() },
  });

  res.json({ ok: true });
});

// ─── GET /users/:addr/beneficiaries ──────────────────────────────────────────

app.get("/users/:addr/beneficiaries", async (req: Request, res: Response) => {
  const { addr } = req.params;

  const user = await prisma.user.findUnique({
    where: { address: addr.toLowerCase() },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const beneficiaries = await prisma.beneficiaryRegistry.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });

  res.json(beneficiaries);
});

// ─── POST /users/:addr/beneficiaries ─────────────────────────────────────────
//
// Body: { recipientHash: "0x...", address: "0x...", label?: "..." }

app.post(
  "/users/:addr/beneficiaries",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const { addr } = req.params;
    const { recipientHash, address, label } = req.body as {
      recipientHash: string;
      address: string;
      label?: string;
    };

    if (!recipientHash || !address) {
      res.status(400).json({ error: "recipientHash and address are required" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { address: addr.toLowerCase() },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const beneficiary = await prisma.beneficiaryRegistry.upsert({
      where: {
        userId_recipientHash: {
          userId: user.id,
          recipientHash: recipientHash.toLowerCase(),
        },
      },
      create: {
        userId: user.id,
        recipientHash: recipientHash.toLowerCase(),
        address: address.toLowerCase(),
        label,
        status: "approved",
      },
      update: {
        address: address.toLowerCase(),
        label,
        status: "approved",
      },
    });

    res.status(201).json(beneficiary);
  },
);

// ─── DELETE /users/:addr/beneficiaries/:hash ────────────────────────────────

app.delete(
  "/users/:addr/beneficiaries/:hash",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const { addr, hash } = req.params;

    const user = await prisma.user.findUnique({
      where: { address: addr.toLowerCase() },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await prisma.beneficiaryRegistry.delete({
      where: {
        userId_recipientHash: {
          userId: user.id,
          recipientHash: hash.toLowerCase(),
        },
      },
    });

    res.json({ ok: true });
  },
);

// ─── POST /safe/propose ──────────────────────────────────────────────────────
//
// User submits a pre-signed Safe tx; bank validates guardrails, co-signs,
// and executes on-chain (reaching the 2/2 threshold).

app.post(
  "/safe/propose",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const proposal = req.body as SafeTxProposal;

    if (
      !proposal.safeAddress ||
      !proposal.safeTx ||
      !proposal.userSignature ||
      !proposal.userAddress
    ) {
      res.status(400).json({
        error:
          "safeAddress, safeTx, userSignature, and userAddress are required",
      });
      return;
    }

    if (!_adminAccount) {
      res.status(500).json({ error: "ADMIN_PRIVATE_KEY not configured" });
      return;
    }

    const result = await processProposal(
      prisma,
      _publicClient,
      process.env.ADMIN_PRIVATE_KEY!,
      RPC_URL,
      proposal,
    );

    if (result.approved) {
      res.json(result);
    } else {
      res.status(403).json(result);
    }
  },
);

// ─── POST /policy/validate ───────────────────────────────────────────────────
//
// Pre-flight check: can this spend intent be auto-signed?

app.post(
  "/policy/validate",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const { userAddress, amount, recipientHash, transferType } = req.body as {
      userAddress: string;
      amount: string;
      recipientHash?: string;
      transferType?: number;
    };

    if (!userAddress || !amount) {
      res.status(400).json({ error: "userAddress and amount are required" });
      return;
    }

    const result = await validateSpendIntent(prisma, _publicClient, {
      userAddress,
      amount,
      recipientHash,
      transferType,
    });

    res.json(result);
  },
);

// ─── GET /pool/status ────────────────────────────────────────────────────────

app.get("/pool/status", async (_req: Request, res: Response) => {
  const status = await getPoolStatus(unlink);

  // Attach token decimals from watched contracts table (defaults to 6 for USDC)
  let tokenDecimals = 6;
  if (status.tokenAddress) {
    const contract = await prisma.watchedContract.findUnique({
      where: { address: status.tokenAddress.toLowerCase() },
    });
    if (contract) tokenDecimals = contract.tokenDecimals;
  }

  res.json({ ...status, tokenDecimals });
});

// ─── POST /users/:addr/deposit ───────────────────────────────────────────────
//
// Record a deposit to the user's internal balance ledger.

app.post(
  "/users/:addr/deposit",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const { addr } = req.params;
    const { token, amount, reference, note } = req.body as {
      token: string;
      amount: string;
      reference?: string;
      note?: string;
    };

    if (!token || !amount) {
      res.status(400).json({ error: "token and amount are required" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { address: addr.toLowerCase() },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const balance = await creditBalance(
      prisma,
      user.id,
      token,
      amount,
      reference,
      note,
    );
    res.status(201).json({ balance });
  },
);

// ─── GET /users/:addr/balance ────────────────────────────────────────────────

app.get("/users/:addr/balance", async (req: Request, res: Response) => {
  const { addr } = req.params;

  const user = await prisma.user.findUnique({
    where: { address: addr.toLowerCase() },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const balances = await getAllBalances(prisma, user.id);
  res.json({ balances });
});

// ─── GET /audit ──────────────────────────────────────────────────────────────

app.get("/audit", requirePrivyAuth, async (req: Request, res: Response) => {
  const action = req.query.action as string | undefined;
  const userId = req.query.userId ? Number(req.query.userId) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const offset = req.query.offset ? Number(req.query.offset) : undefined;

  const logs = await queryAuditLogs(prisma, { action, userId, limit, offset });
  res.json(logs);
});

// ─── GET /ledger/summary ─────────────────────────────────────────────────────
//
// Returns the sum of all UserBalance records as 18-decimal USD string.
// This represents total deposits across all registered users.

app.get("/ledger/summary", async (_req: Request, res: Response) => {
  const balances = await prisma.userBalance.findMany({
    select: { balance: true },
  });
  const total = balances.reduce((sum, b) => sum + BigInt(b.balance), 0n);
  res.json({ totalDeposits: total.toString() });
});

// ─── GET /sub-accounts ────────────────────────────────────────────────────────

app.get("/sub-accounts", async (_req: Request, res: Response) => {
  const accounts = await prisma.subAccount.findMany({
    orderBy: { createdAt: "asc" },
  });
  res.json(accounts);
});

// ─── POST /sub-accounts ───────────────────────────────────────────────────────
//
// Body: { name, operator, balance?, deployed?, dailyLimit?, spentToday?, status?, protocols?, pnl?, perfData? }

app.post("/sub-accounts", async (req: Request, res: Response) => {
  const {
    name,
    operator,
    balance = 0,
    deployed = 0,
    dailyLimit = 500_000,
    spentToday = 0,
    status = "active",
    protocols = "[]",
    pnl = 0,
    perfData = "[]",
  } = req.body as {
    name: string;
    operator: string;
    balance?: number;
    deployed?: number;
    dailyLimit?: number;
    spentToday?: number;
    status?: string;
    protocols?: string;
    pnl?: number;
    perfData?: string;
  };

  if (!name || !operator) {
    res.status(400).json({ error: "name and operator are required" });
    return;
  }

  const account = await prisma.subAccount.create({
    data: {
      name,
      operator,
      balance,
      deployed,
      dailyLimit,
      spentToday,
      status,
      protocols,
      pnl,
      perfData,
    },
  });

  res.status(201).json(account);
});

// ─── PATCH /sub-accounts/:id ──────────────────────────────────────────────────
//
// Body: any subset of { dailyLimit, protocols, status, balance, deployed, spentToday, pnl, perfData }

app.patch("/sub-accounts/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const account = await prisma.subAccount.update({
    where: { id },
    data: {
      ...req.body,
      lastActivity: new Date(),
    },
  });

  res.json(account);
});

// ─── DELETE /sub-accounts/:id ─────────────────────────────────────────────────

app.delete("/sub-accounts/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  await prisma.subAccount.delete({ where: { id } });
  res.json({ ok: true });
});

// ─── GET /dead-letter ────────────────────────────────────────────────────────
//
// List events that failed all retries and were moved to dead letter queue.

app.get("/dead-letter", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);

  const events = await prisma.spendAuthorizedEvent.findMany({
    where: { withdrawalStatus: "dead_letter" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(
    events.map((e) => ({
      ...e,
      blockNumber: e.blockNumber.toString(),
    })),
  );
});

// ─── POST /dead-letter/:id/retry ────────────────────────────────────────────
//
// Manually retry a dead-letter event by resetting it to pending.

app.post(
  "/dead-letter/:id/retry",
  requirePrivyAuth,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);

    const event = await prisma.spendAuthorizedEvent.findUnique({
      where: { id },
    });

    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    if (event.withdrawalStatus !== "dead_letter") {
      res.status(400).json({ error: "Event is not in dead letter queue" });
      return;
    }

    await prisma.spendAuthorizedEvent.update({
      where: { id },
      data: {
        withdrawalStatus: "pending",
        retryCount: 0,
        nextRetryAt: null,
        scheduledAt: new Date(),
        withdrawalError: null,
      },
    });

    res.json({ ok: true, id });
  },
);

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error:", message);
  res.status(500).json({ error: message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

await initWallet();
startWatcher(prisma, unlink);
startPoolMonitor(prisma, unlink);
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
