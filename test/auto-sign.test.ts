import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMockPrisma,
  createMockPublicClient,
  makeUser,
  type MockPrisma,
  type MockPublicClient,
} from "./mocks.js";

// Mock dependencies
vi.mock("../audit.js", () => ({
  AUDIT_ACTIONS: {
    AUTO_SIGN_APPROVED: "auto_sign_approved",
    AUTO_SIGN_REJECTED: "auto_sign_rejected",
    DEPOSIT_RECORDED: "deposit_recorded",
  },
  logAudit: vi.fn(),
}));

vi.mock("@safe-global/protocol-kit", () => {
  const mockSafeSdk = {
    createTransaction: vi.fn(async () => ({
      addSignature: vi.fn(),
    })),
    signTransaction: vi.fn(async (tx: unknown) => tx),
    executeTransaction: vi.fn(async () => ({ hash: "0xexechash" })),
  };
  return {
    default: {
      init: vi.fn(async () => mockSafeSdk),
    },
    EthSafeSignature: vi
      .fn()
      .mockImplementation((addr: string, sig: string) => ({ addr, sig })),
  };
});

// Must import AFTER mocks are set up
const { processProposal } = await import("../auto-sign.js");

describe("auto-sign — processProposal", () => {
  let prisma: MockPrisma;
  let publicClient: MockPublicClient;

  const baseTx = {
    to: "0xrecipient",
    value: "0",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: 0,
  };

  const makeProposal = (overrides: Record<string, unknown> = {}) => ({
    safeAddress: "0xsafe1",
    safeTx: { ...baseTx },
    userSignature: "0xsig",
    userAddress: "0xuser1",
    ...overrides,
  });

  beforeEach(() => {
    prisma = createMockPrisma();
    publicClient = createMockPublicClient();
    prisma._store.users.push(makeUser());
    prisma._store.userBalances.push({
      id: 1,
      userId: 1,
      token: "usd",
      balance: "100000000000000000000000",
    });
    publicClient.readContract.mockResolvedValue(99_999n * 10n ** 18n);
  });

  it("rejects when user not found", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const result = await processProposal(
      prisma as any,
      publicClient as any,
      "0xadminkey",
      "http://rpc",
      makeProposal({ userAddress: "0xnonexistent" }) as any,
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("not registered");
  });

  it("rejects when safe address doesn't match", async () => {
    const result = await processProposal(
      prisma as any,
      publicClient as any,
      "0xadminkey",
      "http://rpc",
      makeProposal({ safeAddress: "0xwrongsafe" }) as any,
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("does not match");
  });

  it("rejects when tx value exceeds auto-sign limit", async () => {
    const result = await processProposal(
      prisma as any,
      publicClient as any,
      "0xadminkey",
      "http://rpc",
      makeProposal({
        safeTx: { ...baseTx, value: "999999999999999999999999" }, // huge value
      }) as any,
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("exceeds auto-sign limit");
  });

  it("approves valid zero-value transaction (contract call)", async () => {
    const result = await processProposal(
      prisma as any,
      publicClient as any,
      "0xadminkey",
      "http://rpc",
      makeProposal() as any,
    );

    expect(result.approved).toBe(true);
    expect(result.txHash).toBe("0xexechash");
  });

  it("rejects when policy validation fails for value > 0", async () => {
    prisma.balanceLedger.findMany.mockResolvedValueOnce([]);
    // Override: insufficient balance
    prisma._store.userBalances.length = 0;
    prisma.userBalance.findUnique.mockResolvedValueOnce(null);

    const result = await processProposal(
      prisma as any,
      publicClient as any,
      "0xadminkey",
      "http://rpc",
      makeProposal({
        safeTx: { ...baseTx, value: "1000000000000000000" },
      }) as any,
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
