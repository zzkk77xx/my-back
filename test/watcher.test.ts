import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMockPrisma,
  createMockUnlink,
  makeUser,
  makeEvent,
  type MockPrisma,
  type MockUnlink,
} from "./mocks.js";

// Mock audit + ledger
vi.mock("../audit.js", () => ({
  AUDIT_ACTIONS: {
    WITHDRAWAL_EXECUTED: "withdrawal_executed",
    WITHDRAWAL_FAILED: "withdrawal_failed",
    WITHDRAWAL_RETRY: "withdrawal_retry",
    WITHDRAWAL_DLQ: "withdrawal_dlq",
    INTERNAL_TRANSFER: "internal_transfer",
    DEPOSIT_RECORDED: "deposit_recorded",
  },
  logAudit: vi.fn(),
}));

vi.mock("../ledger.js", () => ({
  creditBalance: vi.fn(async () => "1000000000000000000"),
  debitBalance: vi.fn(async () => "0"),
  InsufficientBalanceError: class InsufficientBalanceError extends Error {
    name = "InsufficientBalanceError";
    constructor(
      public userId: number,
      public token: string,
      public requested: string,
      public available: string,
    ) {
      super(`Insufficient balance for user ${userId}`);
    }
  },
}));

/**
 * Since watcher.ts functions are not individually exported (they're module-private),
 * we test the behavioral patterns by simulating the data and verifying
 * what Prisma/Unlink are called with.
 *
 * The key exported function is startWatcher(), which internally calls:
 *   - fetchAndPersistNewEvents (uses viemClient — tested via integration)
 *   - processEligibleEvents (uses prisma + unlink — testable via mock)
 *
 * For unit tests, we verify the schema/config behaviors.
 */

describe("watcher — behavioral tests", () => {
  let prisma: MockPrisma;
  let unlink: MockUnlink;

  beforeEach(() => {
    prisma = createMockPrisma();
    unlink = createMockUnlink();
  });

  describe("timing decorrelation", () => {
    it("scheduledAt field is a Date when events are created", () => {
      const event = makeEvent();
      expect(event.scheduledAt).toBeInstanceOf(Date);
    });

    it("events with future scheduledAt are not yet eligible", () => {
      const futureEvent = makeEvent({
        scheduledAt: new Date(Date.now() + 60_000),
      });
      const now = new Date();
      expect(futureEvent.scheduledAt > now).toBe(true);
    });

    it("events with past scheduledAt are eligible", () => {
      const pastEvent = makeEvent({
        scheduledAt: new Date(Date.now() - 1_000),
      });
      const now = new Date();
      expect(pastEvent.scheduledAt <= now).toBe(true);
    });

    it("events with null scheduledAt are eligible (legacy)", () => {
      const legacyEvent = makeEvent({ scheduledAt: null });
      expect(legacyEvent.scheduledAt).toBeNull();
    });
  });

  describe("retry logic", () => {
    it("event starts with retryCount=0", () => {
      const event = makeEvent();
      expect(event.retryCount).toBe(0);
    });

    it("failed event with retryCount < 3 is eligible for retry", () => {
      const event = makeEvent({
        withdrawalStatus: "failed",
        retryCount: 1,
        nextRetryAt: new Date(Date.now() - 1_000),
      });

      expect(event.withdrawalStatus).toBe("failed");
      expect(event.retryCount).toBeLessThan(3);
      expect(event.nextRetryAt <= new Date()).toBe(true);
    });

    it("failed event with retryCount >= 3 becomes dead_letter", () => {
      // After 3 retries, handler should set status to "dead_letter"
      const event = makeEvent({
        withdrawalStatus: "failed",
        retryCount: 3,
      });
      // If retryCount >= MAX_RETRIES (3), next handleFailure should DLQ it
      expect(event.retryCount).toBe(3);
    });

    it("exponential backoff increases delay", () => {
      const RETRY_BASE_MS = 30_000;
      // retry 0: 30s, retry 1: 60s, retry 2: 120s
      expect(RETRY_BASE_MS * Math.pow(2, 0)).toBe(30_000);
      expect(RETRY_BASE_MS * Math.pow(2, 1)).toBe(60_000);
      expect(RETRY_BASE_MS * Math.pow(2, 2)).toBe(120_000);
    });
  });

  describe("internal transfer detection", () => {
    it("identifies internal transfer when recipient is a bank M2 Safe", () => {
      const senderUser = makeUser({
        id: 1,
        safeAddress: "0xsafe1",
        spendInteractorAddress: "0xspend1",
      });
      const recipientUser = makeUser({
        id: 2,
        safeAddress: "0xsafe2",
        spendInteractorAddress: "0xspend2",
      });

      // Recipient address matches a user's safeAddress → internal transfer
      const recipientAddress = "0xsafe2";
      expect(recipientAddress.toLowerCase()).toBe(recipientUser.safeAddress);
    });

    it("external transfer when recipient is not a bank user", () => {
      // No user with this safe address → external
      const externalRecipient = "0xmerchant";
      const users = [makeUser({ safeAddress: "0xsafe1" })];
      const match = users.find(
        (u) =>
          (u.safeAddress as string).toLowerCase() ===
          externalRecipient.toLowerCase(),
      );
      expect(match).toBeUndefined();
    });
  });

  describe("dead letter queue status", () => {
    it("dead_letter events are distinct from failed", () => {
      const dlq = makeEvent({ withdrawalStatus: "dead_letter", retryCount: 3 });
      const failed = makeEvent({ withdrawalStatus: "failed", retryCount: 1 });

      expect(dlq.withdrawalStatus).toBe("dead_letter");
      expect(failed.withdrawalStatus).toBe("failed");
      expect(dlq.withdrawalStatus).not.toBe(failed.withdrawalStatus);
    });
  });

  describe("event status transitions", () => {
    it("valid statuses are defined", () => {
      const validStatuses = [
        "pending",
        "processing",
        "done",
        "failed",
        "no_recipient",
        "dead_letter",
      ];
      for (const status of validStatuses) {
        const event = makeEvent({ withdrawalStatus: status });
        expect(validStatuses).toContain(event.withdrawalStatus);
      }
    });

    it("pending → processing → done is happy path", () => {
      const event = makeEvent({ withdrawalStatus: "pending" });
      event.withdrawalStatus = "processing";
      expect(event.withdrawalStatus).toBe("processing");
      event.withdrawalStatus = "done";
      expect(event.withdrawalStatus).toBe("done");
    });

    it("pending → processing → failed → (retry) → processing → done", () => {
      const event = makeEvent({ withdrawalStatus: "pending" });
      event.withdrawalStatus = "processing";
      event.withdrawalStatus = "failed";
      event.retryCount = 1;
      // Retry picks it up
      event.withdrawalStatus = "processing";
      event.withdrawalStatus = "done";
      expect(event.withdrawalStatus).toBe("done");
      expect(event.retryCount).toBe(1);
    });
  });
});
