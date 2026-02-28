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
import express, { type Request, type Response } from "express";
import { startWatcher } from "./watcher.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const MNEMONIC = process.env.UNLINK_MNEMONIC;
if (!MNEMONIC) throw new Error("UNLINK_MNEMONIC env var is required");

const DEFAULT_RECIPIENT = process.env.SAFE_ADDRESS as `0x${string}` | undefined;
const PORT = Number(process.env.PORT ?? 3000);

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

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── GET /account ─────────────────────────────────────────────────────────────

app.get("/account", async (_req: Request, res: Response) => {
  const account = await unlink.accounts.getActive();
  res.json({ address: account!.address });
});

// ─── GET /balances ────────────────────────────────────────────────────────────

app.get("/balances", async (_req: Request, res: Response) => {
  const raw = await unlink.getBalances();
  const balances = Object.fromEntries(
    Object.entries(raw).map(([token, amount]) => [token, amount.toString()])
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
    res.status(400).json({ error: "depositor, token, and amount are required" });
    return;
  }

  const deposit = await unlink.deposit({
    depositor: depositor as `0x${string}`,
    deposits: [{ token: token as `0x${string}`, amount: BigInt(amount) }],
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
  res.json({ ok: true });
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
    withdrawals: [{ token: token as `0x${string}`, amount: BigInt(amount), recipient: to }],
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
    }))
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

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error:", message);
  res.status(500).json({ error: message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

await initWallet();
startWatcher(prisma, unlink);
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
