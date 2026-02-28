import { describe, it, expect, beforeEach } from "vitest";
import { createMockPrisma, type MockPrisma } from "./mocks.js";
import { AUDIT_ACTIONS, logAudit, queryAuditLogs } from "../audit.js";

describe("audit", () => {
  let prisma: MockPrisma;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  describe("logAudit", () => {
    it("creates an audit log entry", async () => {
      await logAudit(prisma as any, AUDIT_ACTIONS.AUTO_SIGN_APPROVED, 1, {
        txHash: "0xabc",
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: "auto_sign_approved",
          userId: 1,
          details: JSON.stringify({ txHash: "0xabc" }),
        },
      });
    });

    it("accepts null userId", async () => {
      await logAudit(prisma as any, AUDIT_ACTIONS.POOL_TOPUP, null, {
        amount: "100",
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: "pool_topup",
          userId: null,
          details: JSON.stringify({ amount: "100" }),
        },
      });
    });

    it("never throws even if prisma fails", async () => {
      prisma.auditLog.create.mockRejectedValueOnce(new Error("DB down"));

      // Should not throw
      await expect(
        logAudit(prisma as any, AUDIT_ACTIONS.WITHDRAWAL_FAILED, null, {}),
      ).resolves.toBeUndefined();
    });

    it("covers all new audit actions", () => {
      expect(AUDIT_ACTIONS.WITHDRAWAL_DLQ).toBe("withdrawal_dlq");
      expect(AUDIT_ACTIONS.WITHDRAWAL_RETRY).toBe("withdrawal_retry");
      expect(AUDIT_ACTIONS.POOL_SWEEP).toBe("pool_sweep");
      expect(AUDIT_ACTIONS.POOL_SWEEP_FAILED).toBe("pool_sweep_failed");
      expect(AUDIT_ACTIONS.INTERNAL_TRANSFER).toBe("internal_transfer");
    });
  });

  describe("queryAuditLogs", () => {
    it("calls findMany with default options", async () => {
      await queryAuditLogs(prisma as any);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: "desc" },
        take: 50,
        skip: 0,
      });
    });

    it("applies action and userId filters", async () => {
      await queryAuditLogs(prisma as any, {
        action: "auto_sign_approved",
        userId: 5,
        limit: 10,
        offset: 20,
      });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: { action: "auto_sign_approved", userId: 5 },
        orderBy: { createdAt: "desc" },
        take: 10,
        skip: 20,
      });
    });

    it("caps limit at 200", async () => {
      await queryAuditLogs(prisma as any, { limit: 500 });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 }),
      );
    });
  });
});
