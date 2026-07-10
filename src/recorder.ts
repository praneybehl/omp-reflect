import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import {
	ACTIVITY_REFLECTION_FINISH_TYPE,
	ACTIVITY_REFLECTION_SCHEMA_VERSION,
	ACTIVITY_REFLECTION_SIDECAR,
	ACTIVITY_REFLECTION_START_TYPE,
	type ActivityReflectionAttemptFinish,
	type ActivityReflectionAttemptStart,
	type ActivityReflectionFinding,
	type ActivityReflectionModelRef,
	type ActivityReflectionStatus,
	type ActivityReflectionUsage,
} from "./wire.ts";

const JSONL_SUFFIX = ".jsonl";

export interface SessionLocator {
	/** Stable session id. */
	id: string;
	/** Absolute path to the main session JSONL. */
	path: string;
	/** Project cwd associated with the session. */
	cwd: string;
}

export type ListSessions = () => Promise<SessionLocator[]>;

export interface ReflectRecorderOptions {
	/** Current session manager (preferred when ids match). */
	sessionManager: Pick<
		SessionManager,
		"getSessionId" | "getSessionFile" | "getCwd"
	>;
	/** Fallback listing for moved/other sessions. */
	listAll: ListSessions;
}

export interface StartAttemptInput {
	attemptId: string;
	sourceSessionId: string;
	sourceEntryIds: string[];
	project: string;
	startedAt: number;
	model: ActivityReflectionModelRef;
}

export interface FinishAttemptInput {
	attemptId: string;
	sourceSessionId: string;
	status: ActivityReflectionStatus;
	finishedAt: number;
	durationMs: number;
	usage?: ActivityReflectionUsage;
	errorCategory?: string;
	findings?: ActivityReflectionFinding[];
}

/**
 * Serialized append-only writer for `__omp-reflect.jsonl` sidecars.
 * Modeled on AdvisorTranscriptRecorder's promise-tail queue.
 */
export class ReflectRecorder {
	#sessionManager: ReflectRecorderOptions["sessionManager"];
	#listAll: ListSessions;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: ReflectRecorderOptions) {
		this.#sessionManager = options.sessionManager;
		this.#listAll = options.listAll;
	}

	/**
	 * Resolve the owning main session JSONL for a stable session id.
	 * Returns undefined when the session was dropped.
	 */
	async resolveOwner(
		sourceSessionId: string,
	): Promise<SessionLocator | undefined> {
		const currentId = this.#sessionManager.getSessionId();
		if (currentId === sourceSessionId) {
			const sessionFile = this.#sessionManager.getSessionFile();
			if (sessionFile && fs.existsSync(sessionFile)) {
				return {
					id: sourceSessionId,
					path: sessionFile,
					cwd: this.#sessionManager.getCwd(),
				};
			}
		}

		const all = await this.#listAll();
		const match = all.find((s) => s.id === sourceSessionId);
		if (!match) return undefined;
		if (!fs.existsSync(match.path)) return undefined;
		return match;
	}

	/** Sidecar path beside the main session JSONL. */
	sidecarPath(sessionFile: string): string {
		if (!sessionFile.endsWith(JSONL_SUFFIX)) {
			return path.join(sessionFile, ACTIVITY_REFLECTION_SIDECAR);
		}
		return path.join(
			sessionFile.slice(0, -JSONL_SUFFIX.length),
			ACTIVITY_REFLECTION_SIDECAR,
		);
	}

	/** Write attempt-start before model dispatch. */
	writeStart(input: StartAttemptInput): Promise<boolean> {
		const payload: ActivityReflectionAttemptStart = {
			attemptId: input.attemptId,
			schemaVersion: ACTIVITY_REFLECTION_SCHEMA_VERSION,
			sourceSessionId: input.sourceSessionId,
			sourceEntryIds: input.sourceEntryIds,
			project: input.project,
			startedAt: input.startedAt,
			model: input.model,
		};
		return this.#append(input.sourceSessionId, {
			type: "custom",
			customType: ACTIVITY_REFLECTION_START_TYPE,
			data: payload,
			timestamp: new Date(input.startedAt).toISOString(),
			id: input.attemptId,
			parentId: null,
		});
	}

	/**
	 * Write exactly one finish status. Findings only on validated success.
	 * Never persists raw excerpts or raw provider errors.
	 */
	writeFinish(input: FinishAttemptInput): Promise<boolean> {
		const findings =
			input.status === "success" && input.findings && input.findings.length > 0
				? input.findings
				: [];
		const payload: ActivityReflectionAttemptFinish = {
			attemptId: input.attemptId,
			schemaVersion: ACTIVITY_REFLECTION_SCHEMA_VERSION,
			status: input.status,
			finishedAt: input.finishedAt,
			durationMs: input.durationMs,
			usage: input.usage,
			errorCategory:
				input.status === "success" ? undefined : input.errorCategory,
			findings,
		};
		return this.#append(input.sourceSessionId, {
			type: "custom",
			customType: ACTIVITY_REFLECTION_FINISH_TYPE,
			data: payload,
			timestamp: new Date(input.finishedAt).toISOString(),
			id: `${input.attemptId}:finish`,
			parentId: input.attemptId,
		});
	}

	/** Flush the write queue. */
	flush(): Promise<void> {
		const next = this.#queue.then(
			() => {},
			() => {},
		);
		this.#queue = next;
		return next;
	}

	/**
	 * Read successful reflection source entry ids already covered for a session.
	 */
	async listCoveredSourceIds(sourceSessionId: string): Promise<Set<string>> {
		const owner = await this.resolveOwner(sourceSessionId);
		if (!owner) return new Set();
		const sidecar = this.sidecarPath(owner.path);
		if (!fs.existsSync(sidecar)) return new Set();
		const text = await fsPromises.readFile(sidecar, "utf8");
		const covered = new Set<string>();
		const starts = new Map<string, string[]>();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object") continue;
			const entry = parsed as Record<string, unknown>;
			if (
				entry.customType === ACTIVITY_REFLECTION_START_TYPE &&
				isRecord(entry.data)
			) {
				const data = entry.data;
				const attemptId =
					typeof data.attemptId === "string" ? data.attemptId : undefined;
				const ids = Array.isArray(data.sourceEntryIds)
					? data.sourceEntryIds.filter(
							(x): x is string => typeof x === "string",
						)
					: [];
				if (attemptId) starts.set(attemptId, ids);
			}
			if (
				entry.customType === ACTIVITY_REFLECTION_FINISH_TYPE &&
				isRecord(entry.data)
			) {
				const data = entry.data;
				if (data.status !== "success") continue;
				const attemptId =
					typeof data.attemptId === "string" ? data.attemptId : undefined;
				if (!attemptId) continue;
				const ids = starts.get(attemptId) ?? [];
				for (const id of ids) covered.add(id);
			}
		}
		return covered;
	}

	/**
	 * Load latest successful findings from the current session's sidecar.
	 */
	async loadLatestFindings(
		sourceSessionId: string,
	): Promise<ActivityReflectionFinding[]> {
		const owner = await this.resolveOwner(sourceSessionId);
		if (!owner) return [];
		const sidecar = this.sidecarPath(owner.path);
		if (!fs.existsSync(sidecar)) return [];
		const text = await fsPromises.readFile(sidecar, "utf8");
		let latest: ActivityReflectionFinding[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object") continue;
			const entry = parsed as Record<string, unknown>;
			if (
				entry.customType !== ACTIVITY_REFLECTION_FINISH_TYPE ||
				!isRecord(entry.data)
			)
				continue;
			const data = entry.data;
			if (data.status !== "success" || !Array.isArray(data.findings)) continue;
			latest = data.findings.filter(isFinding);
		}
		return latest;
	}

	async #append(
		sourceSessionId: string,
		entry: Record<string, unknown>,
	): Promise<boolean> {
		const work = async (): Promise<boolean> => {
			const owner = await this.resolveOwner(sourceSessionId);
			if (!owner) {
				logger.debug("reflect recorder dropped write: session missing", {
					sourceSessionId,
				});
				return false;
			}
			if (!fs.existsSync(owner.path)) {
				logger.debug("reflect recorder dropped write: main JSONL missing", {
					sourceSessionId,
					path: owner.path,
				});
				return false;
			}
			const sidecar = this.sidecarPath(owner.path);
			await fsPromises.mkdir(path.dirname(sidecar), { recursive: true });
			const line = `${JSON.stringify(entry)}\n`;
			await fsPromises.appendFile(sidecar, line, "utf8");
			return true;
		};

		const result = this.#queue.then(work, work);
		this.#queue = result.then(
			() => {},
			() => {},
		);
		try {
			return await result;
		} catch (err) {
			logger.debug("reflect recorder append failed", { err: String(err) });
			return false;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFinding(value: unknown): value is ActivityReflectionFinding {
	if (!isRecord(value)) return false;
	return (
		typeof value.category === "string" &&
		typeof value.observation === "string" &&
		typeof value.evidence === "string" &&
		typeof value.suggestion === "string" &&
		typeof value.expectedImpact === "string" &&
		typeof value.confidence === "string" &&
		Array.isArray(value.sourceEntryIds)
	);
}
