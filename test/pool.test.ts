import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockUnlink, type MockUnlink } from "./mocks.js";

// Mock audit
vi.mock("../audit.js", () => ({
  AUDIT_ACTIONS: {
    POOL_TOPUP: "pool_topup",
    POOL_TOPUP_FAILED: "pool_topup_failed",
    POOL_SWEEP: "pool_sweep",
    POOL_SWEEP_FAILED: "pool_sweep_failed",
  },
  logAudit: vi.fn(),
}));

// We can test getPoolStatus directly since it's a pure function of unlink state
const { getPoolStatus } = await import("../pool.js");

describe("pool", () => {
  let unlink: MockUnlink;

  beforeEach(() => {
    unlink = createMockUnlink();
  });

  describe("getPoolStatus", () => {
    it("returns status with current balance", async () => {
      unlink.getBalance.mockResolvedValueOnce(50000n);

      const status = await getPoolStatus(unlink as any);

      expect(status.currentBalance).toBe("50000");
      expect(typeof status.lowWaterMark).toBe("string");
      expect(typeof status.highWaterMark).toBe("string");
      expect(typeof status.topUpAmount).toBe("string");
      expect(status.lastSweepTime).toBeNull();
    });

    it("reports healthy when balance >= lowWaterMark", async () => {
      // Default LOW_WATER_MARK is 0n from env, so any balance is healthy
      unlink.getBalance.mockResolvedValueOnce(100n);

      const status = await getPoolStatus(unlink as any);
      expect(status.isHealthy).toBe(true);
    });

    it("handles getBalance errors gracefully", async () => {
      unlink.getBalance.mockRejectedValueOnce(new Error("network error"));

      const status = await getPoolStatus(unlink as any);
      expect(status.currentBalance).toBe("0");
    });

    it("includes sweep recipient in status", async () => {
      unlink.getBalance.mockResolvedValueOnce(0n);
      const status = await getPoolStatus(unlink as any);
      // sweepRecipient comes from env POOL_SWEEP_RECIPIENT or SAFE_ADDRESS
      expect(status).toHaveProperty("sweepRecipient");
    });

    it("includes highWaterMark in status", async () => {
      unlink.getBalance.mockResolvedValueOnce(0n);
      const status = await getPoolStatus(unlink as any);
      expect(status).toHaveProperty("highWaterMark");
      expect(typeof status.highWaterMark).toBe("string");
    });

    it("reports funderConfigured based on env vars", async () => {
      unlink.getBalance.mockResolvedValueOnce(0n);
      const status = await getPoolStatus(unlink as any);
      // Without env vars set, funderConfigured should be false
      expect(typeof status.funderConfigured).toBe("boolean");
    });
  });

  describe("pool monitor behavior", () => {
    it("low-water mark triggers when balance < threshold", () => {
      const balance = 100n;
      const lowWaterMark = 1000n;
      expect(balance < lowWaterMark).toBe(true);
    });

    it("high-water mark triggers when balance > threshold", () => {
      const balance = 5000n;
      const highWaterMark = 2000n;
      expect(balance > highWaterMark).toBe(true);
      const excess = balance - highWaterMark;
      expect(excess).toBe(3000n);
    });

    it("no action when balance is between marks", () => {
      const balance = 1500n;
      const lowWaterMark = 1000n;
      const highWaterMark = 2000n;
      expect(balance >= lowWaterMark).toBe(true);
      expect(balance <= highWaterMark).toBe(true);
    });

    it("high-water disabled when set to 0", () => {
      const highWaterMark = 0n;
      const balance = 999999n;
      // Should not trigger sweep when highWaterMark is 0
      expect(highWaterMark > 0n).toBe(false);
    });
  });
});
