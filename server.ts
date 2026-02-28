/**
 * Unlink HTTP API
 *
 * Exposes deposit/withdraw operations over Express.
 *
 * Env vars:
 *   SAFE_ADDRESS    - Default withdrawal recipient (0x-prefixed Safe address)
 *   DB_PATH         - SQLite wallet path (default: ./data/wallet.db)
 *   PORT            - Server port (default: 3000)
 */

import {
  createSqliteStorage,
  initUnlink,
  type Unlink,
} from "@unlink-xyz/node";
import express, { type Request, type Response } from "express";

// ─── Wallet singleton ─────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH ?? "./data/wallet.db";
const DEFAULT_RECIPIENT = process.env.SAFE_ADDRESS as `0x${string}` | undefined;
const PORT = Number(process.env.PORT ?? 3000);

let unlink: Unlink;

async function initWallet() {
  unlink = await initUnlink({
    chain: "monad-testnet",
    storage: createSqliteStorage({ path: DB_PATH }),
  });
  const account = await unlink.accounts.getActive();
  console.log("Wallet ready. Active account:", account.address);
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── GET /account ─────────────────────────────────────────────────────────────

app.get("/account", async (_req: Request, res: Response) => {
  const account = await unlink.accounts.getActive();
  res.json({ address: account.address });
});

// ─── GET /balances ────────────────────────────────────────────────────────────

app.get("/balances", async (_req: Request, res: Response) => {
  const raw = await unlink.getBalances();
  // Serialize bigints to strings for JSON
  const balances = Object.fromEntries(
    Object.entries(raw).map(([token, amount]) => [token, amount.toString()])
  );
  res.json(balances);
});

// ─── POST /deposit/prepare ────────────────────────────────────────────────────
//
// Body: { depositor: "0x...", token: "0x...", amount: "1000000" }
// Returns: { to, calldata, relayId }
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
// Call this after the depositor has submitted the prepared tx on-chain.

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
// recipient defaults to SAFE_ADDRESS env var.
// Returns: { relayId } immediately — poll /relay/:relayId for status.

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
  res.json({
    state: status.state,
    txHash: status.txHash ?? null,
  });
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error:", message);
  res.status(500).json({ error: message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

await initWallet();
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
