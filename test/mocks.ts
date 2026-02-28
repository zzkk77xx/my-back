/**
 * Shared mock factories for Vitest.
 *
 * Provides lightweight in-memory mocks for PrismaClient, viem PublicClient,
 * and Unlink SDK — no real database or RPC needed.
 */

import { vi } from "vitest";

// ─── Prisma Mock ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Creates a minimal mock PrismaClient that records calls and returns
 * configurable responses. NOT a full Prisma implementation — just
 * enough for unit testing the business logic.
 */
export function createMockPrisma() {
  const store = {
    users: [] as Row[],
    spendAuthorizedEvents: [] as Row[],
    watchedContracts: [] as Row[],
    recipientMappings: [] as Row[],
    userBalances: [] as Row[],
    balanceLedger: [] as Row[],
    auditLogs: [] as Row[],
    meta: [] as Row[],
    beneficiaryRegistry: [] as Row[],
  };

  // Transaction helper: for our mocks, just execute the callback with the prisma mock itself
  const $transaction = vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return arg(mockPrisma);
    }
    // Array of promises (batch transaction)
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return arg;
  });

  const $queryRaw = vi.fn(async () => [{ "?column?": 1 }]);

  const makeModel = (storeName: keyof typeof store) => ({
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      return (
        store[storeName].find((r) =>
          Object.entries(where).every(([k, v]) => {
            if (typeof v === "object" && v !== null) {
              // Handle compound unique keys like { userId_token: { userId, token } }
              return Object.entries(v as Row).every(([ck, cv]) => r[ck] === cv);
            }
            return r[k] === v;
          }),
        ) ?? null
      );
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      return (
        store[storeName].find((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        ) ?? null
      );
    }),
    findMany: vi.fn(async (_args?: unknown) => store[storeName]),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = {
        id: store[storeName].length + 1,
        ...data,
        createdAt: new Date(),
      };
      store[storeName].push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const idx = store[storeName].findIndex((r) =>
        Object.entries(where).every(([k, v]) => r[k] === v),
      );
      if (idx >= 0) Object.assign(store[storeName][idx], data);
      return store[storeName][idx] ?? { ...where, ...data };
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update: upd,
      }: {
        where: Row;
        create: Row;
        update: Row;
      }) => {
        const existing = store[storeName].find((r) =>
          Object.entries(where).every(([k, v]) => {
            if (typeof v === "object" && v !== null) {
              return Object.entries(v as Row).every(([ck, cv]) => r[ck] === cv);
            }
            return r[k] === v;
          }),
        );
        if (existing) {
          Object.assign(existing, upd);
          return existing;
        }
        const row = {
          id: store[storeName].length + 1,
          ...create,
          createdAt: new Date(),
        };
        store[storeName].push(row);
        return row;
      },
    ),
    delete: vi.fn(async ({ where }: { where: Row }) => {
      const idx = store[storeName].findIndex((r) =>
        Object.entries(where).every(([k, v]) => r[k] === v),
      );
      if (idx >= 0) return store[storeName].splice(idx, 1)[0];
      return null;
    }),
    count: vi.fn(async (_args?: unknown) => store[storeName].length),
  });

  const mockPrisma = {
    $transaction,
    $queryRaw,
    user: makeModel("users"),
    spendAuthorizedEvent: makeModel("spendAuthorizedEvents"),
    watchedContract: makeModel("watchedContracts"),
    recipientMapping: makeModel("recipientMappings"),
    userBalance: makeModel("userBalances"),
    balanceLedger: makeModel("balanceLedger"),
    auditLog: makeModel("auditLogs"),
    meta: makeModel("meta"),
    beneficiaryRegistry: makeModel("beneficiaryRegistry"),
    _store: store,
  };

  return mockPrisma;
}

export type MockPrisma = ReturnType<typeof createMockPrisma>;

// ─── viem PublicClient Mock ──────────────────────────────────────────────────

export function createMockPublicClient() {
  return {
    readContract: vi.fn(async () => 0n),
    getBlockNumber: vi.fn(async () => 1000n),
    getLogs: vi.fn(async () => []),
    waitForTransactionReceipt: vi.fn(async () => ({})),
  };
}

export type MockPublicClient = ReturnType<typeof createMockPublicClient>;

// ─── Unlink Mock ─────────────────────────────────────────────────────────────

export function createMockUnlink() {
  return {
    getBalance: vi.fn(async (_token: string) => 50000n),
    getBalances: vi.fn(async () => ({})),
    withdraw: vi.fn(async () => ({ relayId: "mock-relay-id" })),
    deposit: vi.fn(async () => ({
      to: "0x1234",
      calldata: "0x",
      value: 0n,
      relayId: "mock-deposit-relay",
    })),
    confirmDeposit: vi.fn(async () => {}),
    getTxStatus: vi.fn(async () => ({ state: "confirmed", txHash: "0xabc" })),
    accounts: {
      getActive: vi.fn(async () => ({ address: "0xpool" })),
      create: vi.fn(async () => {}),
    },
    seed: { importMnemonic: vi.fn(async () => {}) },
    sync: vi.fn(async () => {}),
  };
}

export type MockUnlink = ReturnType<typeof createMockUnlink>;

// ─── Test data helpers ───────────────────────────────────────────────────────

export function makeUser(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    address: "0xuser1",
    safeAddress: "0xsafe1",
    spendInteractorAddress: "0xspend1",
    createdAt: new Date(),
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    blockNumber: 100n,
    txHash: "0xtx1",
    logIndex: 0,
    contractAddress: "0xspend1",
    m2: "0xsafe1",
    eoa: "0xeoa1",
    amount: "1000000000000000000", // 1 USD in 18-dec
    recipientHash: "0xreciphash1",
    transferType: 0,
    nonce: "1",
    withdrawalStatus: "pending",
    withdrawalRelayId: null,
    withdrawalError: null,
    retryCount: 0,
    nextRetryAt: null,
    scheduledAt: new Date(Date.now() - 60_000), // already past
    createdAt: new Date(),
    ...overrides,
  };
}
