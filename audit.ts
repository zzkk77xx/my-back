/**
 * Compliance audit logging utility.
 *
 * All decisions (auto-sign approve/reject, withdrawals, deposits, pool top-ups)
 * are recorded to the audit_logs table for compliance and debugging.
 *
 * logAudit is fire-and-forget — it never throws, so callers don't need to
 * handle errors from logging.
 */

import type { PrismaClient } from "@prisma/client";

export const AUDIT_ACTIONS = {
  AUTO_SIGN_APPROVED: "auto_sign_approved",
  AUTO_SIGN_REJECTED: "auto_sign_rejected",
  WITHDRAWAL_EXECUTED: "withdrawal_executed",
  WITHDRAWAL_FAILED: "withdrawal_failed",
  WITHDRAWAL_RETRY: "withdrawal_retry",
  WITHDRAWAL_DLQ: "withdrawal_dlq",
  DEPOSIT_RECORDED: "deposit_recorded",
  POOL_TOPUP: "pool_topup",
  POOL_TOPUP_FAILED: "pool_topup_failed",
  POOL_SWEEP: "pool_sweep",
  POOL_SWEEP_FAILED: "pool_sweep_failed",
  INTERNAL_TRANSFER: "internal_transfer",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Fire-and-forget audit log entry. Never throws.
 */
export async function logAudit(
  prisma: PrismaClient,
  action: AuditAction,
  userId: number | null,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId,
        details: JSON.stringify(details),
      },
    });
  } catch (err) {
    console.error(
      "[audit] Failed to write audit log:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Query audit logs with optional filters.
 */
export async function queryAuditLogs(
  prisma: PrismaClient,
  opts: {
    action?: string;
    userId?: number;
    limit?: number;
    offset?: number;
  } = {},
) {
  const { action, userId, limit = 50, offset = 0 } = opts;

  return prisma.auditLog.findMany({
    where: {
      ...(action ? { action } : {}),
      ...(userId !== undefined ? { userId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
    skip: offset,
  });
}
