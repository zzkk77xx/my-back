import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMockPrisma,
  createMockPublicClient,
  makeUser,
  type MockPrisma,
  type MockPublicClient,
} from "./mocks.js";
import {
  validateSpendIntent,
  AUTO_SIGN_LIMIT_USD,
  VELOCITY_7D_LIMIT_USD,
  VELOCITY_30D_LIMIT_USD,
} from "../policy.js";

// Mock audit
vi.mock("../audit.js", () => ({
  AUDIT_ACTIONS: { DEPOSIT_RECORDED: "deposit_recorded" },
  logAudit: vi.fn(),
}));

describe("policy — validateSpendIntent", () => {
  let prisma: MockPrisma;
  let publicClient: MockPublicClient;

  beforeEach(() => {
    prisma = createMockPrisma();
    publicClient = createMockPublicClient();

    // Default: user exists with sufficient balance + on-chain limit
    prisma._store.users.push(makeUser());
    prisma._store.userBalances.push({
      id: 1,
      userId: 1,
      token: "usd",
      balance: "100000000000000000000000", // 100k USD
    });

    // On-chain getRemainingLimit returns large number by default
    publicClient.readContract.mockResolvedValue(99_999n * 10n ** 18n);
  });

  it("rejects when user not found", async () => {
    prisma._store.users.length = 0; // clear users
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xnonexistent",
        amount: "1000000000000000000",
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("User not registered");
  });

  it("rejects zero amount", async () => {
    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "0",
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("greater than zero");
  });

  it("rejects amount exceeding auto-sign cap ($10k)", async () => {
    const overLimit = (AUTO_SIGN_LIMIT_USD + 1n).toString();

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: overLimit,
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("auto-sign limit");
  });

  it("rejects when 7-day velocity exceeded", async () => {
    // Seed spend history exceeding 7d limit
    const sevenDayLimit = VELOCITY_7D_LIMIT_USD;
    prisma.balanceLedger.findMany.mockResolvedValueOnce([
      { amount: sevenDayLimit.toString(), createdAt: new Date() },
    ]);

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000", // 1 USD — any more exceeds
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("7-day");
  });

  it("rejects when 30-day velocity exceeded", async () => {
    const thirtyDayLimit = VELOCITY_30D_LIMIT_USD;
    prisma.balanceLedger.findMany.mockResolvedValueOnce([
      { amount: thirtyDayLimit.toString(), createdAt: new Date() },
    ]);

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("30-day");
  });

  it("rejects blocked beneficiary", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    prisma.beneficiaryRegistry.findUnique.mockResolvedValueOnce({
      id: 1,
      userId: 1,
      recipientHash: "0xreciphash",
      address: "0xrecip",
      status: "blocked",
    });

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
        recipientHash: "0xreciphash",
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  it("flags first-time recipient but still allows", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    prisma.beneficiaryRegistry.findUnique.mockResolvedValueOnce(null); // unknown recipient

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
        recipientHash: "0xnewhash",
      },
    );

    expect(result.allowed).toBe(true);
    expect(result.firstTimeRecipient).toBe(true);
    expect(result.recipientKnown).toBe(false);
  });

  it("marks known beneficiary", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    prisma.beneficiaryRegistry.findUnique.mockResolvedValueOnce({
      id: 1,
      userId: 1,
      recipientHash: "0xknown",
      address: "0xrecip",
      status: "approved",
    });

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
        recipientHash: "0xknown",
      },
    );

    expect(result.allowed).toBe(true);
    expect(result.recipientKnown).toBe(true);
    expect(result.firstTimeRecipient).toBe(false);
  });

  it("rejects insufficient balance", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    // Override balance to 0
    prisma._store.userBalances.length = 0;
    prisma.userBalance.findUnique.mockResolvedValueOnce(null); // getBalance returns "0"

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Insufficient");
  });

  it("rejects when on-chain daily limit exceeded", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    publicClient.readContract.mockResolvedValueOnce(0n); // no remaining limit

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("daily spending limit");
  });

  it("rejects when on-chain limit check fails", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    publicClient.readContract.mockRejectedValueOnce(new Error("RPC timeout"));

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("On-chain limit check failed");
  });

  it("rejects disallowed transfer type", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    // First call: getRemainingLimit
    publicClient.readContract.mockResolvedValueOnce(99_999n * 10n ** 18n);
    // Second call: getAllowedTypesBitmap — returns 0b001 (only type 0 allowed)
    publicClient.readContract.mockResolvedValueOnce(1);

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
        transferType: 1, // type 1 not in bitmap
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Transfer type 1 not allowed");
  });

  it("approves valid spend with all fields populated", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    publicClient.readContract.mockResolvedValueOnce(99_999n * 10n ** 18n); // remaining
    publicClient.readContract.mockResolvedValueOnce(0b11); // types 0,1 allowed

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
        transferType: 0,
      },
    );

    expect(result.allowed).toBe(true);
    expect(result.remainingDaily).toBeDefined();
    expect(result.remainingBalance).toBeDefined();
    expect(result.remaining7d).toBeDefined();
    expect(result.remaining30d).toBeDefined();
  });

  it("returns velocity remaining amounts on success", async () => {
    // 10 USD spent in last 7d
    prisma.balanceLedger.findMany.mockResolvedValueOnce([
      { amount: "10000000000000000000", createdAt: new Date() },
    ]);

    const result = await validateSpendIntent(
      prisma as any,
      publicClient as any,
      {
        userAddress: "0xuser1",
        amount: "1000000000000000000",
      },
    );

    expect(result.allowed).toBe(true);
    const rem7d = BigInt(result.remaining7d!);
    expect(rem7d).toBe(VELOCITY_7D_LIMIT_USD - 10000000000000000000n);
  });
});
