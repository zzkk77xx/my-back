/**
 * Per-user balance tracking.
 *
 * Users can only spend what they deposited. All mutations are atomic
 * (prisma.$transaction) and produce an immutable BalanceLedger entry.
 *
 * Token convention: "usd" for USD-denominated spending balance.
 * All amounts are 18-decimal strings (matching SpendInteractor convention).
 */

import type { PrismaClient } from "@prisma/client";
import { AUDIT_ACTIONS, logAudit } from "./audit.js";

export class InsufficientBalanceError extends Error {
  constructor(
    public userId: number,
    public token: string,
    public requested: string,
    public available: string
  ) {
    super(
      `Insufficient balance for user ${userId}: requested ${requested} ${token}, available ${available}`
    );
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Credit (increase) a user's balance. Used for deposits and refunds.
 */
export async function creditBalance(
  prisma: PrismaClient,
  userId: number,
  token: string,
  amount: string,
  reference?: string,
  note?: string
): Promise<string> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.userBalance.findUnique({
      where: { userId_token: { userId, token } },
    });

    const currentBalance = BigInt(existing?.balance ?? "0");
    const newBalance = (currentBalance + BigInt(amount)).toString();

    await tx.userBalance.upsert({
      where: { userId_token: { userId, token } },
      create: { userId, token, balance: newBalance },
      update: { balance: newBalance },
    });

    await tx.balanceLedger.create({
      data: {
        userId,
        token,
        type: "deposit",
        amount,
        reference,
        note,
      },
    });

    return newBalance;
  });

  await logAudit(prisma, AUDIT_ACTIONS.DEPOSIT_RECORDED, userId, {
    token,
    amount,
    reference,
    newBalance: result,
  });

  return result;
}

/**
 * Debit (decrease) a user's balance. Used for spending.
 * Throws InsufficientBalanceError if balance < amount.
 */
export async function debitBalance(
  prisma: PrismaClient,
  userId: number,
  token: string,
  amount: string,
  reference?: string,
  note?: string
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.userBalance.findUnique({
      where: { userId_token: { userId, token } },
    });

    const currentBalance = BigInt(existing?.balance ?? "0");
    const debitAmount = BigInt(amount);

    if (currentBalance < debitAmount) {
      throw new InsufficientBalanceError(
        userId,
        token,
        amount,
        currentBalance.toString()
      );
    }

    const newBalance = (currentBalance - debitAmount).toString();

    await tx.userBalance.update({
      where: { userId_token: { userId, token } },
      data: { balance: newBalance },
    });

    await tx.balanceLedger.create({
      data: {
        userId,
        token,
        type: "spend",
        amount,
        reference,
        note,
      },
    });

    return newBalance;
  });
}

/**
 * Get the current balance for a user + token. Returns "0" if no record.
 */
export async function getBalance(
  prisma: PrismaClient,
  userId: number,
  token: string
): Promise<string> {
  const record = await prisma.userBalance.findUnique({
    where: { userId_token: { userId, token } },
  });
  return record?.balance ?? "0";
}

/**
 * Get all balances for a user.
 */
export async function getAllBalances(
  prisma: PrismaClient,
  userId: number
): Promise<Array<{ token: string; balance: string }>> {
  const records = await prisma.userBalance.findMany({
    where: { userId },
    select: { token: true, balance: true },
  });
  return records;
}

/**
 * Read-only check: does the user have at least `amount` of `token`?
 */
export async function hasSufficientBalance(
  prisma: PrismaClient,
  userId: number,
  token: string,
  amount: string
): Promise<boolean> {
  const balance = await getBalance(prisma, userId, token);
  return BigInt(balance) >= BigInt(amount);
}
