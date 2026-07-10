import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export const REFLECT_DB_FILENAME = "omp-reflect.sqlite";
export const LEASE_MS = 120_000;
export const HEARTBEAT_MS = 30_000;
export const SUCCESS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FAILURE_FLOOR_MS = 60 * 60 * 1000;

export interface ReflectScheduleState {
	enabled: boolean;
	lease_owner: string | null;
	lease_until: number | null;
	last_attempt_at: number | null;
	last_success_at: number | null;
	next_scheduled_attempt_at: number | null;
}

export interface LeaseHandle {
	owner: string;
	/** Renew the lease if still held by this owner. Returns false when lost. */
	renew(): boolean;
	/** Release the lease if still held by this owner. */
	release(): void;
	/** True when this owner still holds a non-expired lease. */
	isHeld(): boolean;
}

export interface ReflectSchedule {
	/** Close the underlying database. */
	close(): void;
	/** Read the singleton schedule row. */
	getState(): ReflectScheduleState;
	/** Persist automatic mode. */
	setEnabled(enabled: boolean): void;
	/**
	 * Try to claim the cross-process lease. Returns a handle on success, or
	 * null when another owner still holds a live lease.
	 */
	tryClaimLease(now?: number): LeaseHandle | null;
	/**
	 * Whether a scheduled (auto) run is allowed by cadence/backoff right now.
	 * Manual runs bypass this check.
	 */
	canSchedule(now?: number): boolean;
	/**
	 * Record a completed attempt. Success advances last_success_at and sets the
	 * next attempt 24h out. Failure sets a 1h floor. Always records last_attempt_at.
	 * No-ops when the owner no longer holds the lease.
	 */
	commitAttempt(
		owner: string,
		result: { success: boolean },
		now?: number,
	): boolean;
}

function emptyState(): ReflectScheduleState {
	return {
		enabled: false,
		lease_owner: null,
		lease_until: null,
		last_attempt_at: null,
		last_success_at: null,
		next_scheduled_attempt_at: null,
	};
}

function parseScheduleRow(row: unknown): ReflectScheduleState {
	if (!row || typeof row !== "object") return emptyState();
	const r = row as Record<string, unknown>;
	return {
		enabled: r.enabled === 1,
		lease_owner: typeof r.lease_owner === "string" ? r.lease_owner : null,
		lease_until: typeof r.lease_until === "number" ? r.lease_until : null,
		last_attempt_at:
			typeof r.last_attempt_at === "number" ? r.last_attempt_at : null,
		last_success_at:
			typeof r.last_success_at === "number" ? r.last_success_at : null,
		next_scheduled_attempt_at:
			typeof r.next_scheduled_attempt_at === "number"
				? r.next_scheduled_attempt_at
				: null,
	};
}

/**
 * Open (or create) the process-local reflect schedule DB under the agent dir.
 * `dbPath` is a test seam.
 */
export function openReflectSchedule(dbPath?: string): ReflectSchedule {
	const resolved = dbPath ?? path.join(getAgentDir(), REFLECT_DB_FILENAME);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	const db = new Database(resolved);
	db.exec(`
		CREATE TABLE IF NOT EXISTS reflect_schedule (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			enabled INTEGER NOT NULL DEFAULT 0,
			lease_owner TEXT,
			lease_until INTEGER,
			last_attempt_at INTEGER,
			last_success_at INTEGER,
			next_scheduled_attempt_at INTEGER
		);
		INSERT OR IGNORE INTO reflect_schedule (id) VALUES (1);
	`);

	const read = (): ReflectScheduleState => {
		const row = db
			.query(
				`SELECT enabled, lease_owner, lease_until, last_attempt_at, last_success_at, next_scheduled_attempt_at
				 FROM reflect_schedule WHERE id = 1`,
			)
			.get();
		return parseScheduleRow(row);
	};

	const ownerHolds = (owner: string, now: number): boolean => {
		const state = read();
		return state.lease_owner === owner && (state.lease_until ?? 0) > now;
	};

	return {
		close() {
			db.close();
		},
		getState: read,
		setEnabled(enabled: boolean) {
			db.query(`UPDATE reflect_schedule SET enabled = ? WHERE id = 1`).run(
				enabled ? 1 : 0,
			);
		},
		tryClaimLease(now = Date.now()): LeaseHandle | null {
			const owner = crypto.randomUUID();
			const until = now + LEASE_MS;
			const result = db
				.query(
					`UPDATE reflect_schedule
					 SET lease_owner = ?, lease_until = ?
					 WHERE id = 1
					   AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until <= ?)`,
				)
				.run(owner, until, now);
			if (result.changes !== 1) return null;

			return {
				owner,
				renew(): boolean {
					const t = Date.now();
					if (!ownerHolds(owner, t)) return false;
					const r = db
						.query(
							`UPDATE reflect_schedule
							 SET lease_until = ?
							 WHERE id = 1 AND lease_owner = ?`,
						)
						.run(t + LEASE_MS, owner);
					return r.changes === 1;
				},
				release(): void {
					db.query(
						`UPDATE reflect_schedule
						 SET lease_owner = NULL, lease_until = NULL
						 WHERE id = 1 AND lease_owner = ?`,
					).run(owner);
				},
				isHeld(): boolean {
					return ownerHolds(owner, Date.now());
				},
			};
		},
		canSchedule(now = Date.now()): boolean {
			const state = read();
			if (!state.enabled) return false;
			if (
				state.next_scheduled_attempt_at != null &&
				now < state.next_scheduled_attempt_at
			) {
				return false;
			}
			return true;
		},
		commitAttempt(
			owner: string,
			result: { success: boolean },
			now = Date.now(),
		): boolean {
			if (!ownerHolds(owner, now)) return false;
			const next = result.success
				? now + SUCCESS_INTERVAL_MS
				: now + FAILURE_FLOOR_MS;
			if (result.success) {
				db.query(
					`UPDATE reflect_schedule
					 SET last_attempt_at = ?, last_success_at = ?, next_scheduled_attempt_at = ?
					 WHERE id = 1 AND lease_owner = ?`,
				).run(now, now, next, owner);
			} else {
				db.query(
					`UPDATE reflect_schedule
					 SET last_attempt_at = ?, next_scheduled_attempt_at = ?
					 WHERE id = 1 AND lease_owner = ?`,
				).run(now, next, owner);
			}
			return true;
		},
	};
}
