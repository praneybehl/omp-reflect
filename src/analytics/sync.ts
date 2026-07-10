import * as fs from "node:fs/promises";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { type ActivityDb, ActivityLeaseLostError } from "./db.ts";
import {
	type ActivityParseResult,
	listSessionFiles,
	parseActivitySession,
} from "./parser.ts";

/** A crashed activity sync is recoverable after two minutes. */
export const ACTIVITY_SYNC_LEASE_MS = 120_000;
/** The holder renews every 30 seconds while it parses. */
export const ACTIVITY_SYNC_HEARTBEAT_MS = 30_000;
/** Interactive callers wait at most one minute for another process. */
export const ACTIVITY_SYNC_WAIT_MS = 60_000;
/** Poll cadence while another process owns the lease. */
export const ACTIVITY_SYNC_POLL_MS = 250;

interface ActivityFileStat {
	mtimeMs: number;
}

export interface SyncActivityOptions {
	/** Explicit source directory; avoids global-agent-dir mutation in tests. */
	sessionsDir?: string;
	/** Listing seam for callers that source sessions differently. */
	listFiles?: (sessionsDir: string) => Promise<string[]>;
	/** Parser seam for deterministic sync tests. */
	parseSession?: (
		sessionFile: string,
		fromOffset: number,
		sessionsDir: string,
	) => Promise<ActivityParseResult>;
	/** Stat seam used to distinguish absent owners from transient failures. */
	stat?: (sessionFile: string) => Promise<ActivityFileStat>;
	/** Narrow timing seams for lease-race tests. */
	leaseTtlMs?: number;
	heartbeatMs?: number;
	waitMs?: number;
	pollMs?: number;
	/** Poll seam lets lease tests advance without wall-clock timers. */
	sleep?: (ms: number) => Promise<void>;
}

let syncQueueTail: Promise<unknown> = Promise.resolve();

/**
 * Incrementally ingest every host session into the extension-owned database.
 * Process-local callers serialize through a rejection-safe tail; independent
 * processes serialize through the database lease before reconciliation/listing.
 */
export function syncActivity(
	db: ActivityDb,
	options?: SyncActivityOptions,
): Promise<{ processed: number; files: number }> {
	const run = syncQueueTail.then(
		() => syncActivityUnqueued(db, options),
		() => syncActivityUnqueued(db, options),
	);
	syncQueueTail = run.catch(() => {});
	return run;
}

async function syncActivityUnqueued(
	db: ActivityDb,
	options?: SyncActivityOptions,
): Promise<{ processed: number; files: number }> {
	const sessionsDir = options?.sessionsDir ?? getSessionsDir();
	const listFiles = options?.listFiles ?? listSessionFiles;
	const parseSession = options?.parseSession ?? parseActivitySession;
	const stat = options?.stat ?? fs.stat;
	const leaseTtlMs = Math.max(1, options?.leaseTtlMs ?? ACTIVITY_SYNC_LEASE_MS);
	const heartbeatMs = Math.max(
		1,
		options?.heartbeatMs ?? ACTIVITY_SYNC_HEARTBEAT_MS,
	);
	const waitMs = Math.max(0, options?.waitMs ?? ACTIVITY_SYNC_WAIT_MS);
	const pollMs = Math.max(1, options?.pollMs ?? ACTIVITY_SYNC_POLL_MS);
	const sleep = options?.sleep ?? Bun.sleep;
	const owner = crypto.randomUUID();
	const deadline = Date.now() + waitMs;

	while (!db.tryClaimLease(owner, leaseTtlMs)) {
		if (Date.now() >= deadline)
			throw new Error("Activity sync is already running in another process.");
		await sleep(pollMs);
	}

	let leaseLost = false;
	const heartbeat = setInterval(() => {
		if (!db.renewLease(owner, leaseTtlMs)) leaseLost = true;
	}, heartbeatMs);

	try {
		// Reclaim only owners proven absent. A transient EACCES/EMFILE must never
		// erase rows, and reclamation precedes listing so a surviving fork can win.
		const missingFiles: string[] = [];
		for (const knownOwner of db.listKnownOwners()) {
			try {
				await stat(knownOwner);
			} catch (error) {
				if (isEnoent(error)) missingFiles.push(knownOwner);
			}
		}
		if (missingFiles.length > 0)
			db.reconcileMissingOwnersUnderLease(owner, missingFiles);

		const files = await listFiles(sessionsDir);
		let processed = 0;
		let parsedFiles = 0;
		for (const sessionFile of files) {
			let fileStat: ActivityFileStat;
			try {
				fileStat = await stat(sessionFile);
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}

			const stored = db.getOffset(sessionFile);
			if (stored && stored.lastModified >= fileStat.mtimeMs) continue;
			const result = await parseSession(
				sessionFile,
				stored?.offset ?? 0,
				sessionsDir,
			);
			if (leaseLost) throw new ActivityLeaseLostError(owner);
			const inserted = db.applyParseResultUnderLease(
				owner,
				sessionFile,
				fileStat.mtimeMs,
				result,
			);
			if (inserted > 0) {
				processed += inserted;
				parsedFiles++;
			}
		}
		return { processed, files: parsedFiles };
	} finally {
		clearInterval(heartbeat);
		db.releaseLease(owner);
	}
}
