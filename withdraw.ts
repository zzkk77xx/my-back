/**
 * Withdraw from an Unlink private account to a Safe multisig address.
 *
 * Required env vars:
 *   SAFE_ADDRESS    - 0x-prefixed address of the destination Safe
 *   TOKEN_ADDRESS   - 0x-prefixed ERC-20 token contract address
 *   AMOUNT          - Amount to withdraw in the token's smallest unit (bigint string, e.g. "1000000")
 *
 * Optional:
 *   DB_PATH         - SQLite file path (default: ./data/wallet.db)
 */

import {
  createSqliteStorage,
  initUnlink,
  TransactionFailedError,
  waitForConfirmation,
} from "@unlink-xyz/node";

// ─── Config ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env variable: ${name}`);
  return value;
}

const SAFE_ADDRESS = requireEnv("SAFE_ADDRESS") as `0x${string}`;
const TOKEN_ADDRESS = requireEnv("TOKEN_ADDRESS") as `0x${string}`;
const AMOUNT = BigInt(requireEnv("AMOUNT"));
const DB_PATH = process.env.DB_PATH ?? "./data/wallet.db";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Initializing Unlink wallet...");

  const unlink = await initUnlink({
    chain: "monad-testnet",
    storage: createSqliteStorage({ path: DB_PATH }),
  });

  // Log the active private account address so you can look it up or fund it
  const account = await unlink.accounts.getActive();
  console.log("Active Unlink account:", account.address);

  // Current private balance for the token
  const balance = await unlink.getBalance(TOKEN_ADDRESS);
  console.log(`Private balance: ${balance} (raw units)`);

  if (balance < AMOUNT) {
    throw new Error(
      `Insufficient private balance. Have ${balance}, need ${AMOUNT}.`
    );
  }

  console.log(
    `Withdrawing ${AMOUNT} of ${TOKEN_ADDRESS} → Safe at ${SAFE_ADDRESS} ...`
  );

  const result = await unlink.withdraw({
    withdrawals: [
      {
        token: TOKEN_ADDRESS,
        amount: AMOUNT,
        recipient: SAFE_ADDRESS,
      },
    ],
  });

  console.log(`Relay submitted. ID: ${result.relayId}`);
  console.log("Waiting for confirmation (up to 5 min)...");

  const status = await waitForConfirmation(unlink, result.relayId);

  console.log("✔ Withdrawal confirmed!");
  console.log("  Tx hash :", status.txHash);
  console.log("  State   :", status.state);
}

main().catch((err) => {
  if (err instanceof TransactionFailedError) {
    console.error("Transaction failed:", err.state, "-", err.reason);
  } else {
    console.error(err.message ?? err);
  }
  process.exit(1);
});
