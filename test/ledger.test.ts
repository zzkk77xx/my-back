import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockPrisma, type MockPrisma } from "./mocks.js";
import {
  creditBalance,
  debitBalance,
  getBalance,
  getAllBalances,
  hasSufficientBalance,
  InsufficientBalanceError,
} from "../ledger.js";

// Mock audit to prevent it from calling prisma.auditLog.create during tests
vi.mock("../audit.js", () => ({
  AUDIT_ACTIONS: { DEPOSIT_RECORDED: "deposit_recorded" },
  logAudit: vi.fn(),
}));

describe("ledger", () => {
  let prisma: MockPrisma;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  describe("creditBalance", () => {
    it("creates a new balance record on first deposit", async () => {
      // $transaction calls the callback with the prisma mock
      const result = await creditBalance(
        prisma as any,
        1,
        "usd",
        "5000000000000000000",
      );

      expect(result).toBe("5000000000000000000");
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("increases existing balance", async () => {
      // Seed a balance record
      prisma._store.userBalances.push({
        id: 1,
        userId: 1,
        token: "usd",
        balance: "10000000000000000000", // 10 USD
      });

      const result = await creditBalance(
        prisma as any,
        1,
        "usd",
        "5000000000000000000",
      );

      // Should attempt to upsert the new balance (10 + 5 = 15)
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result).toBe("15000000000000000000");
    });
  });

  describe("debitBalance", () => {
    it("decreases balance and creates ledger entry", async () => {
      prisma._store.userBalances.push({
        id: 1,
        userId: 1,
        token: "usd",
        balance: "10000000000000000000",
      });

      const result = await debitBalance(
        prisma as any,
        1,
        "usd",
        "3000000000000000000",
      );

      expect(result).toBe("7000000000000000000");
    });

    it("throws InsufficientBalanceError when balance too low", async () => {
      prisma._store.userBalances.push({
        id: 1,
        userId: 1,
        token: "usd",
        balance: "1000000000000000000", // 1 USD
      });

      await expect(
        debitBalance(prisma as any, 1, "usd", "5000000000000000000"), // 5 USD
      ).rejects.toThrow(InsufficientBalanceError);
    });

    it("throws InsufficientBalanceError when no balance exists", async () => {
      await expect(
        debitBalance(prisma as any, 1, "usd", "1000000000000000000"),
      ).rejects.toThrow(InsufficientBalanceError);
    });
  });

  describe("getBalance", () => {
    it("returns balance string when exists", async () => {
      prisma._store.userBalances.push({
        id: 1,
        userId: 1,
        token: "usd",
        balance: "42000000000000000000",
      });

      const result = await getBalance(prisma as any, 1, "usd");
      expect(result).toBe("42000000000000000000");
    });

    it("returns '0' when no record exists", async () => {
      const result = await getBalance(prisma as any, 999, "usd");
      expect(result).toBe("0");
    });
  });

  describe("getAllBalances", () => {
    it("returns all user balances", async () => {
      prisma._store.userBalances.push(
        { id: 1, userId: 1, token: "usd", balance: "100" },
        { id: 2, userId: 1, token: "0xtoken", balance: "200" },
      );

      // findMany returns all records in the store by default
      prisma.userBalance.findMany.mockResolvedValueOnce([
        { token: "usd", balance: "100" },
        { token: "0xtoken", balance: "200" },
      ]);

      const result = await getAllBalances(prisma as any, 1);
      expect(result).toHaveLength(2);
    });
  });

  describe("hasSufficientBalance", () => {
    it("returns true when balance >= amount", async () => {
      prisma._store.userBalances.push({
        id: 1,
        userId: 1,
        token: "usd",
        balance: "10000000000000000000",
      });

      const result = await hasSufficientBalance(
        prisma as any,
        1,
        "usd",
        "5000000000000000000",
      );
      expect(result).toBe(true);
    });

    it("returns false when balance < amount", async () => {
      prisma._store.userBalances.push({
        id: 1,
        userId: 1,
        token: "usd",
        balance: "1000000000000000000",
      });

      const result = await hasSufficientBalance(
        prisma as any,
        1,
        "usd",
        "5000000000000000000",
      );
      expect(result).toBe(false);
    });

    it("returns false when no balance exists", async () => {
      const result = await hasSufficientBalance(
        prisma as any,
        999,
        "usd",
        "1000000000000000000",
      );
      expect(result).toBe(false);
    });
  });

  describe("InsufficientBalanceError", () => {
    it("has the correct properties", () => {
      const err = new InsufficientBalanceError(1, "usd", "100", "50");
      expect(err.name).toBe("InsufficientBalanceError");
      expect(err.userId).toBe(1);
      expect(err.token).toBe("usd");
      expect(err.requested).toBe("100");
      expect(err.available).toBe("50");
      expect(err.message).toContain("Insufficient balance");
    });
  });
});
