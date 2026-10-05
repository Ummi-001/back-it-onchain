import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Well-known `action` values written by OracleService. Kept as a plain
 * string union (rather than a Postgres enum) so new actions never require
 * a migration — callers are free to log other actions too.
 */
export enum AuditLogAction {
  ORACLE_SETTLEMENT = 'oracle.settlement',
  ORACLE_UNRESOLVED = 'oracle.unresolved',
  /** BE-018: a call frozen because its price was stale or untradeable. */
  ORACLE_RESOLUTION_HALTED = 'oracle.resolution_halted',
  /** BE-018: an admin returned a frozen call to the resolution queue. */
  ORACLE_RESOLUTION_UNFROZEN = 'oracle.resolution_unfrozen',

  // ── Disputes (BE-019) ───────────────────────────────────────────────────
  DISPUTE_RAISED = 'dispute.raised',
  DISPUTE_ESCALATED = 'dispute.escalated',
  DISPUTE_OVERTURNED = 'dispute.overturned',
  DISPUTE_CONFIRMED = 'dispute.confirmed',
  ORACLE_KEY_ROTATED = 'oracle.key_rotated',
  /** BE-12: an ed25519 signature over a canonical Soroban resolution payload. */
  ORACLE_RESOLUTION_SIGNED = 'oracle.resolution_signed',
}

@Entity('audit_logs')
@Index('IDX_audit_log_action_created_at', ['action', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Numeric call identifier this log entry relates to (nullable for admin actions). */
  @Column({ nullable: true })
  callId: string;

  /** Action type: e.g. "oracle.sign", "relayer.submit", "admin.pause". */
  @Column()
  action: string;

  /** Wallet address or service identifier that triggered the action. */
  @Column()
  actor: string;

  /** SHA-256 hex hash of the signed / submitted payload for tamper detection. */
  @Column({ nullable: true })
  payloadHash: string;

  /** IPFS CID of supporting evidence attached to this action (optional). */
  @Column({ nullable: true })
  evidenceCid: string;

  // ── Legacy fields kept for backward compatibility with indexer.service.ts ──

  @Column({ nullable: true })
  targetResource: string;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown>;

  /** Chain the action relates to ('base' | 'stellar'), when applicable. */
  @Column({ nullable: true })
  chain: string;

  @CreateDateColumn()
  createdAt: Date;
}
