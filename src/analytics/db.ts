import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { ActivityParseResult } from "./parser.ts";
import type {
	ActivityModelUsage,
	ActivityReasoningLevel,
	ActivityReflectionFeedItem,
	ActivitySkillUsage,
	OwnModelAggregate,
	OwnToolAggregate,
} from "./types.ts";

export const ACTIVITY_DB_FILENAME = "omp-reflect-activity.sqlite";
const SCHEMA_VERSION = "1";

export interface ActivityFileOffset {
	offset: number;
	lastModified: number;
}

export interface ActivityDayRollup {
	date: string;
	tokens: number;
	requests: number;
}

export interface ActivityTaskDay {
	date: string;
	tasks: number;
}

export interface ActivityLongestTask {
	durationMs: number;
	timestamp: number;
	folder: string;
}

export interface ActivityPriorityCounts {
	priorityRequests: number;
	totalRequests: number;
}

/** Thrown before an apply/reconcile transaction writes when its owner lost the sync lease. */
export class ActivityLeaseLostError extends Error {
	constructor(owner: string) {
		super(`Activity sync lease lost for owner ${owner}`);
		this.name = "ActivityLeaseLostError";
	}
}

export interface ActivityDb {
	close(): void;
	getOffset(sessionFile: string): ActivityFileOffset | null;
	setOffset(sessionFile: string, offset: number, lastModified: number): void;
	tryClaimLease(owner: string, ttlMs: number): boolean;
	renewLease(owner: string, ttlMs: number): boolean;
	releaseLease(owner: string): void;
	applyParseResultUnderLease(
		owner: string,
		sessionFile: string,
		lastModified: number,
		result: ActivityParseResult,
	): number;
	listKnownOwners(): string[];
	reconcileMissingOwnersUnderLease(owner: string, missingFiles: string[]): void;
	dayRollup(): ActivityDayRollup[];
	taskDays(): ActivityTaskDay[];
	taskCount(): number;
	longestTask(): ActivityLongestTask | null;
	priorityCounts(): ActivityPriorityCounts;
	reasoningLevels(): ActivityReasoningLevel[];
	skillUsage(): ActivitySkillUsage[];
	reflectionFeed(limit: number): ActivityReflectionFeedItem[];
	modelUsage(): ActivityModelUsage[];
	ownModelAggregates(limit: number): OwnModelAggregate[];
	ownToolAggregates(limit: number): OwnToolAggregate[];
}

const ACTIVITY_SCHEMA = `
	CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_file TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		folder TEXT NOT NULL,
		model TEXT NOT NULL,
		provider TEXT NOT NULL,
		timestamp INTEGER NOT NULL,
		total_tokens INTEGER NOT NULL,
		cost_total REAL NOT NULL,
		is_error INTEGER NOT NULL DEFAULT 0,
		thinking_level TEXT,
		priority_realized INTEGER NOT NULL DEFAULT 0,
		agent_kind TEXT NOT NULL,
		UNIQUE(session_file, entry_id)
	);
	CREATE INDEX IF NOT EXISTS idx_activity_messages_timestamp ON messages(timestamp);
	CREATE INDEX IF NOT EXISTS idx_activity_messages_model ON messages(model, provider);
	CREATE INDEX IF NOT EXISTS idx_activity_messages_session ON messages(session_file);

	CREATE TABLE IF NOT EXISTS user_tasks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_file TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		folder TEXT NOT NULL,
		timestamp INTEGER NOT NULL,
		agent_kind TEXT NOT NULL,
		completed_at INTEGER,
		duration INTEGER,
		UNIQUE(session_file, entry_id)
	);
	CREATE INDEX IF NOT EXISTS idx_activity_tasks_timestamp ON user_tasks(timestamp);
	CREATE INDEX IF NOT EXISTS idx_activity_tasks_session ON user_tasks(session_file);

	CREATE TABLE IF NOT EXISTS tool_calls (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_file TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		tool_call_id TEXT NOT NULL,
		tool_name TEXT NOT NULL,
		timestamp INTEGER NOT NULL,
		is_error INTEGER,
		UNIQUE(session_file, tool_call_id)
	);
	CREATE INDEX IF NOT EXISTS idx_activity_tools_name ON tool_calls(tool_name, timestamp);
	CREATE INDEX IF NOT EXISTS idx_activity_tools_session ON tool_calls(session_file);

	CREATE TABLE IF NOT EXISTS skills (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_file TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		tool_call_id TEXT,
		dedupe_key TEXT NOT NULL,
		skill_name TEXT NOT NULL,
		source TEXT NOT NULL,
		timestamp INTEGER NOT NULL,
		confirmed INTEGER NOT NULL DEFAULT 0,
		UNIQUE(session_file, dedupe_key)
	);
	CREATE INDEX IF NOT EXISTS idx_activity_skills_name ON skills(skill_name, timestamp);
	CREATE INDEX IF NOT EXISTS idx_activity_skills_session ON skills(session_file);

	CREATE TABLE IF NOT EXISTS reflection_attempts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_file TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		folder TEXT NOT NULL,
		source_session_id TEXT NOT NULL,
		project TEXT NOT NULL,
		status TEXT NOT NULL,
		model TEXT NOT NULL,
		provider TEXT NOT NULL,
		started_at INTEGER NOT NULL,
		finished_at INTEGER NOT NULL,
		duration_ms INTEGER NOT NULL,
		error_category TEXT,
		finding_count INTEGER NOT NULL DEFAULT 0,
		UNIQUE(session_file, attempt_id)
	);
	CREATE INDEX IF NOT EXISTS idx_activity_reflections_finished ON reflection_attempts(finished_at);
	CREATE INDEX IF NOT EXISTS idx_activity_reflections_session ON reflection_attempts(session_file);

	CREATE TABLE IF NOT EXISTS reflection_findings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_file TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		position INTEGER NOT NULL,
		category TEXT NOT NULL,
		observation TEXT NOT NULL,
		evidence TEXT NOT NULL,
		suggestion TEXT NOT NULL,
		expected_impact TEXT NOT NULL,
		confidence TEXT NOT NULL,
		source_entry_ids TEXT NOT NULL,
		UNIQUE(session_file, attempt_id, position)
	);
	CREATE INDEX IF NOT EXISTS idx_activity_findings_attempt ON reflection_findings(session_file, attempt_id, position);

	CREATE TABLE IF NOT EXISTS file_offsets (
		session_file TEXT PRIMARY KEY,
		offset INTEGER NOT NULL,
		last_modified INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS activity_sync_lease (
		id INTEGER PRIMARY KEY CHECK(id = 1),
		owner TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	);
`;

const RESETTABLE_TABLES = [
	"reflection_findings",
	"reflection_attempts",
	"skills",
	"tool_calls",
	"user_tasks",
	"messages",
	"file_offsets",
	"activity_sync_lease",
] as const;

/**
 * Open the extension-owned activity database. The optional path is a test seam;
 * production never targets the host stats database.
 */
export function openActivityDb(dbPath?: string): ActivityDb {
	const resolvedPath = dbPath ?? path.join(getAgentDir(), ACTIVITY_DB_FILENAME);
	fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
	const db = new Database(resolvedPath);
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	db.exec(
		"CREATE TABLE IF NOT EXISTS activity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	);

	const version = db
		.query("SELECT value FROM activity_meta WHERE key = 'schema_version'")
		.get() as { value: string } | null;
	if (version?.value !== SCHEMA_VERSION) {
		const reset = db.transaction(() => {
			for (const table of RESETTABLE_TABLES)
				db.exec(`DROP TABLE IF EXISTS ${table}`);
			db.exec(ACTIVITY_SCHEMA);
			db.query(
				"INSERT OR REPLACE INTO activity_meta (key, value) VALUES ('schema_version', ?)",
			).run(SCHEMA_VERSION);
		});
		reset.immediate();
	} else {
		db.exec(ACTIVITY_SCHEMA);
	}

	const offsetQuery = db.query(
		"SELECT offset, last_modified FROM file_offsets WHERE session_file = ?",
	);
	const setOffsetQuery = db.query(`
		INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)
		ON CONFLICT(session_file) DO UPDATE SET offset = excluded.offset, last_modified = excluded.last_modified
	`);
	const leaseQuery = db.query(
		"SELECT owner, expires_at FROM activity_sync_lease WHERE id = 1",
	);

	const assertLease = (owner: string): void => {
		const lease = leaseQuery.get() as {
			owner: string;
			expires_at: number;
		} | null;
		if (!lease || lease.owner !== owner || lease.expires_at <= Date.now())
			throw new ActivityLeaseLostError(owner);
	};

	return {
		close(): void {
			db.close();
		},
		getOffset(sessionFile: string): ActivityFileOffset | null {
			const row = offsetQuery.get(sessionFile) as {
				offset: number;
				last_modified: number;
			} | null;
			return row
				? { offset: row.offset, lastModified: row.last_modified }
				: null;
		},
		setOffset(sessionFile: string, offset: number, lastModified: number): void {
			setOffsetQuery.run(sessionFile, offset, lastModified);
		},
		tryClaimLease(owner: string, ttlMs: number): boolean {
			const claim = db.transaction(() => {
				const now = Date.now();
				const lease = leaseQuery.get() as {
					owner: string;
					expires_at: number;
				} | null;
				if (lease && lease.owner !== owner && lease.expires_at > now)
					return false;
				db.query(
					`INSERT INTO activity_sync_lease (id, owner, expires_at) VALUES (1, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
				).run(owner, now + Math.max(0, ttlMs));
				return true;
			});
			return claim.immediate() as boolean;
		},
		renewLease(owner: string, ttlMs: number): boolean {
			const result = db
				.query(
					"UPDATE activity_sync_lease SET expires_at = ? WHERE id = 1 AND owner = ?",
				)
				.run(Date.now() + Math.max(0, ttlMs), owner);
			return result.changes > 0;
		},
		releaseLease(owner: string): void {
			db.query(
				"DELETE FROM activity_sync_lease WHERE id = 1 AND owner = ?",
			).run(owner);
		},
		applyParseResultUnderLease(
			owner: string,
			sessionFile: string,
			lastModified: number,
			result: ActivityParseResult,
		): number {
			const apply = db.transaction(() => {
				assertLease(owner);
				let inserted = 0;
				const insertMessage = db.query(`
					INSERT INTO messages (
						session_file, entry_id, folder, model, provider, timestamp, total_tokens, cost_total,
						is_error, thinking_level, priority_realized, agent_kind
					)
					SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					WHERE NOT EXISTS (
						SELECT 1 FROM messages WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
					)
					ON CONFLICT(session_file, entry_id) DO NOTHING
				`);
				for (const row of result.messages) {
					const outcome = insertMessage.run(
						row.sessionFile,
						row.entryId,
						row.folder,
						row.model,
						row.provider,
						row.timestamp,
						row.totalTokens,
						row.costTotal,
						row.isError ? 1 : 0,
						row.thinkingLevel,
						row.priorityRealized ? 1 : 0,
						row.agentKind,
						row.entryId,
						row.timestamp,
						row.sessionFile,
					);
					inserted += outcome.changes;
				}

				const insertTask = db.query(`
					INSERT INTO user_tasks (session_file, entry_id, folder, timestamp, agent_kind)
					SELECT ?, ?, ?, ?, ?
					WHERE NOT EXISTS (
						SELECT 1 FROM user_tasks WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
					)
					ON CONFLICT(session_file, entry_id) DO NOTHING
				`);
				for (const row of result.tasks) {
					insertTask.run(
						row.sessionFile,
						row.entryId,
						row.folder,
						row.timestamp,
						row.agentKind,
						row.entryId,
						row.timestamp,
						row.sessionFile,
					);
				}

				const updateTaskSameOwner = db.query(`
					UPDATE user_tasks
					SET completed_at = ?, duration = MAX(0, ? - timestamp)
					WHERE session_file = ? AND entry_id = ? AND (completed_at IS NULL OR completed_at < ?)
				`);
				const updateTaskCanonicalOwner = db.query(`
					UPDATE user_tasks
					SET completed_at = ?, duration = MAX(0, ? - timestamp)
					WHERE entry_id = ? AND (completed_at IS NULL OR completed_at < ?)
				`);
				for (const row of result.taskProgress) {
					const sameOwner = updateTaskSameOwner.run(
						row.completedAt,
						row.completedAt,
						row.sessionFile,
						row.entryId,
						row.completedAt,
					);
					if (sameOwner.changes === 0) {
						updateTaskCanonicalOwner.run(
							row.completedAt,
							row.completedAt,
							row.entryId,
							row.completedAt,
						);
					}
				}

				const insertToolCall = db.query(`
					INSERT INTO tool_calls (session_file, entry_id, tool_call_id, tool_name, timestamp)
					SELECT ?, ?, ?, ?, ?
					WHERE NOT EXISTS (
						SELECT 1 FROM tool_calls
						WHERE entry_id = ? AND timestamp = ? AND tool_call_id = ? AND session_file <> ?
					)
					ON CONFLICT(session_file, tool_call_id) DO NOTHING
				`);
				for (const row of result.toolCalls) {
					insertToolCall.run(
						row.sessionFile,
						row.entryId,
						row.toolCallId,
						row.toolName,
						row.timestamp,
						row.entryId,
						row.timestamp,
						row.toolCallId,
						row.sessionFile,
					);
				}

				const insertSkill = db.query(`
					INSERT INTO skills (
						session_file, entry_id, tool_call_id, dedupe_key, skill_name, source, timestamp, confirmed
					)
					SELECT ?, ?, ?, ?, ?, ?, ?, ?
					WHERE NOT EXISTS (
						SELECT 1 FROM skills
						WHERE dedupe_key = ? AND timestamp = ? AND entry_id = ? AND session_file <> ?
					)
					ON CONFLICT(session_file, dedupe_key) DO UPDATE SET confirmed = MAX(skills.confirmed, excluded.confirmed)
					WHERE skills.confirmed < excluded.confirmed
				`);
				for (const row of result.skills) {
					const dedupeKey = `${row.source}:${row.toolCallId ?? row.entryId}`;
					insertSkill.run(
						row.sessionFile,
						row.entryId,
						row.toolCallId,
						dedupeKey,
						row.skillName,
						row.source,
						row.timestamp,
						row.confirmed ? 1 : 0,
						dedupeKey,
						row.timestamp,
						row.entryId,
						row.sessionFile,
					);
				}

				const updateToolResult = db.query(`
					UPDATE tool_calls SET is_error = ?
					WHERE session_file = ? AND tool_call_id = ? AND is_error IS NULL
				`);
				const confirmSkillSameOwner = db.query(`
					UPDATE skills SET confirmed = 1
					WHERE session_file = ? AND tool_call_id = ? AND source = 'read' AND confirmed = 0
				`);
				const confirmSkillCanonicalOwner = db.query(`
					UPDATE skills SET confirmed = 1
					WHERE tool_call_id = ? AND source = 'read' AND confirmed = 0
				`);
				for (const row of result.toolResults) {
					updateToolResult.run(
						row.isError ? 1 : 0,
						row.sessionFile,
						row.toolCallId,
					);
					if (!row.isError) {
						const sameOwner = confirmSkillSameOwner.run(
							row.sessionFile,
							row.toolCallId,
						);
						if (sameOwner.changes === 0)
							confirmSkillCanonicalOwner.run(row.toolCallId);
					}
				}

				const insertReflection = db.query(`
					INSERT INTO reflection_attempts (
						session_file, attempt_id, folder, source_session_id, project, status, model, provider,
						started_at, finished_at, duration_ms, error_category, finding_count
					)
					SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					WHERE NOT EXISTS (
						SELECT 1 FROM reflection_attempts WHERE attempt_id = ? AND session_file <> ?
					)
					ON CONFLICT(session_file, attempt_id) DO NOTHING
				`);
				const insertFinding = db.query(`
					INSERT INTO reflection_findings (
						session_file, attempt_id, position, category, observation, evidence, suggestion,
						expected_impact, confidence, source_entry_ids
					)
					SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					WHERE NOT EXISTS (
						SELECT 1 FROM reflection_findings
						WHERE attempt_id = ? AND position = ? AND session_file <> ?
					)
					ON CONFLICT(session_file, attempt_id, position) DO NOTHING
				`);
				for (const row of result.reflections) {
					insertReflection.run(
						row.sessionFile,
						row.attemptId,
						row.folder,
						row.sourceSessionId,
						row.project,
						row.status,
						row.model,
						row.provider,
						row.startedAt,
						row.finishedAt,
						row.durationMs,
						row.errorCategory,
						row.findings.length,
						row.attemptId,
						row.sessionFile,
					);
					for (let position = 0; position < row.findings.length; position++) {
						const finding = row.findings[position];
						insertFinding.run(
							row.sessionFile,
							row.attemptId,
							position,
							finding.category,
							finding.observation,
							finding.evidence,
							finding.suggestion,
							finding.expectedImpact,
							finding.confidence,
							JSON.stringify(finding.sourceEntryIds),
							row.attemptId,
							position,
							row.sessionFile,
						);
					}
				}

				setOffsetQuery.run(sessionFile, result.newOffset, lastModified);
				return inserted;
			});
			return apply.immediate() as number;
		},
		listKnownOwners(): string[] {
			const rows = db
				.query(`
					SELECT session_file FROM file_offsets
					UNION SELECT session_file FROM messages
					UNION SELECT session_file FROM user_tasks
					UNION SELECT session_file FROM tool_calls
					UNION SELECT session_file FROM skills
					UNION SELECT session_file FROM reflection_attempts
				`)
				.all() as Array<{ session_file: string }>;
			return rows.map((row) => row.session_file);
		},
		reconcileMissingOwnersUnderLease(
			owner: string,
			missingFiles: string[],
		): void {
			if (missingFiles.length === 0) return;
			const reconcile = db.transaction(() => {
				assertLease(owner);
				for (const table of [
					"messages",
					"user_tasks",
					"tool_calls",
					"skills",
					"reflection_attempts",
					"reflection_findings",
					"file_offsets",
				] as const) {
					const removeOwner = db.query(
						`DELETE FROM ${table} WHERE session_file = ?`,
					);
					for (const sessionFile of missingFiles) removeOwner.run(sessionFile);
				}
				db.run("DELETE FROM file_offsets");
			});
			reconcile.immediate();
		},
		dayRollup(): ActivityDayRollup[] {
			const rows = db
				.query(`
					SELECT date(timestamp / 1000, 'unixepoch', 'localtime') AS day,
					       SUM(total_tokens) AS tokens,
					       COUNT(*) AS requests
					FROM messages
					GROUP BY day
					ORDER BY day ASC
				`)
				.all() as Array<{
				day: string;
				tokens: number | null;
				requests: number;
			}>;
			return rows.map((row) => ({
				date: row.day,
				tokens: row.tokens ?? 0,
				requests: row.requests ?? 0,
			}));
		},
		taskDays(): ActivityTaskDay[] {
			const rows = db
				.query(`
					SELECT date(timestamp / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS tasks
					FROM user_tasks
					WHERE agent_kind = 'main' AND completed_at IS NOT NULL
					GROUP BY day
					ORDER BY day ASC
				`)
				.all() as Array<{ day: string; tasks: number }>;
			return rows.map((row) => ({ date: row.day, tasks: row.tasks ?? 0 }));
		},
		taskCount(): number {
			const row = db
				.query(
					"SELECT COUNT(*) AS count FROM user_tasks WHERE agent_kind = 'main' AND completed_at IS NOT NULL",
				)
				.get() as { count: number } | null;
			return row?.count ?? 0;
		},
		longestTask(): ActivityLongestTask | null {
			const row = db
				.query(`
					SELECT duration, timestamp, folder
					FROM user_tasks
					WHERE agent_kind = 'main' AND duration IS NOT NULL
					ORDER BY duration DESC, timestamp ASC
					LIMIT 1
				`)
				.get() as {
				duration: number;
				timestamp: number;
				folder: string;
			} | null;
			return row
				? {
						durationMs: row.duration,
						timestamp: row.timestamp,
						folder: row.folder,
					}
				: null;
		},
		priorityCounts(): ActivityPriorityCounts {
			const row = db
				.query(
					"SELECT COUNT(*) AS total, SUM(CASE WHEN priority_realized = 1 THEN 1 ELSE 0 END) AS priority FROM messages",
				)
				.get() as { total: number; priority: number | null } | null;
			return {
				priorityRequests: row?.priority ?? 0,
				totalRequests: row?.total ?? 0,
			};
		},
		reasoningLevels(): ActivityReasoningLevel[] {
			const rows = db
				.query(`
					SELECT thinking_level AS level, COUNT(*) AS requests
					FROM messages
					WHERE thinking_level IS NOT NULL
					GROUP BY thinking_level
					ORDER BY requests DESC, thinking_level ASC
				`)
				.all() as Array<{ level: string; requests: number }>;
			const knownRequests = rows.reduce(
				(total, row) => total + row.requests,
				0,
			);
			return rows.map((row) => ({
				level: row.level,
				requests: row.requests,
				share: knownRequests > 0 ? row.requests / knownRequests : 0,
			}));
		},
		skillUsage(): ActivitySkillUsage[] {
			const rows = db
				.query(`
					SELECT skill_name, COUNT(*) AS uses, MAX(timestamp) AS last_used
					FROM skills
					WHERE confirmed = 1
					GROUP BY skill_name
					ORDER BY uses DESC, last_used DESC, skill_name ASC
				`)
				.all() as Array<{
				skill_name: string;
				uses: number;
				last_used: number;
			}>;
			const totalUses = rows.reduce((total, row) => total + row.uses, 0);
			return rows.map((row) => ({
				skill: row.skill_name,
				uses: row.uses,
				share: totalUses > 0 ? row.uses / totalUses : 0,
				lastUsed: row.last_used ?? 0,
			}));
		},
		reflectionFeed(limit: number): ActivityReflectionFeedItem[] {
			const boundedLimit = Math.max(0, Math.floor(limit));
			if (boundedLimit === 0) return [];
			const rows = db
				.query(`
					SELECT f.attempt_id, f.category, f.observation, f.evidence, f.suggestion,
					       f.expected_impact, f.confidence, a.project, a.model, a.provider, a.finished_at
					FROM reflection_findings f
					JOIN reflection_attempts a ON a.session_file = f.session_file AND a.attempt_id = f.attempt_id
					WHERE a.status = 'success'
					ORDER BY a.finished_at DESC, f.position ASC
					LIMIT ?
				`)
				.all(boundedLimit) as Array<{
				attempt_id: string;
				category: string;
				observation: string;
				evidence: string;
				suggestion: string;
				expected_impact: string;
				confidence: string;
				project: string;
				model: string;
				provider: string;
				finished_at: number;
			}>;
			return rows.map((row) => ({
				attemptId: row.attempt_id,
				category: row.category,
				observation: row.observation,
				evidence: row.evidence,
				suggestion: row.suggestion,
				expectedImpact: row.expected_impact,
				confidence: row.confidence,
				project: row.project,
				model: row.model,
				provider: row.provider,
				finishedAt: row.finished_at,
			}));
		},
		modelUsage(): ActivityModelUsage[] {
			const rows = db
				.query(`
					SELECT model, provider, COUNT(*) AS requests, SUM(total_tokens) AS total_tokens
					FROM messages
					GROUP BY model, provider
					ORDER BY requests DESC, total_tokens DESC, provider ASC, model ASC
				`)
				.all() as Array<{
				model: string;
				provider: string;
				requests: number;
				total_tokens: number | null;
			}>;
			const totalRequests = rows.reduce(
				(total, row) => total + row.requests,
				0,
			);
			return rows.map((row) => ({
				model: row.model,
				provider: row.provider,
				requests: row.requests,
				share: totalRequests > 0 ? row.requests / totalRequests : 0,
				totalTokens: row.total_tokens ?? 0,
			}));
		},
		ownModelAggregates(limit: number): OwnModelAggregate[] {
			const boundedLimit = Math.max(0, Math.floor(limit));
			if (boundedLimit === 0) return [];
			const rows = db
				.query(`
					SELECT model, provider, COUNT(*) AS total_requests,
					       SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS failed_requests,
					       SUM(total_tokens) AS total_tokens, SUM(cost_total) AS total_cost,
					       MAX(timestamp) AS last_timestamp
					FROM messages
					GROUP BY model, provider
					ORDER BY total_requests DESC, total_tokens DESC, total_cost DESC, provider ASC, model ASC
					LIMIT ?
				`)
				.all(boundedLimit) as Array<{
				model: string;
				provider: string;
				total_requests: number;
				failed_requests: number | null;
				total_tokens: number | null;
				total_cost: number | null;
				last_timestamp: number | null;
			}>;
			return rows.map((row) => ({
				model: row.model,
				provider: row.provider,
				totalRequests: row.total_requests,
				failedRequests: row.failed_requests ?? 0,
				totalTokens: row.total_tokens ?? 0,
				totalCost: row.total_cost ?? 0,
				lastTimestamp: row.last_timestamp ?? 0,
			}));
		},
		ownToolAggregates(limit: number): OwnToolAggregate[] {
			const boundedLimit = Math.max(0, Math.floor(limit));
			if (boundedLimit === 0) return [];
			const rows = db
				.query(`
					SELECT tool_name, COUNT(*) AS calls,
					       SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors,
					       MAX(timestamp) AS last_used
					FROM tool_calls
					GROUP BY tool_name
					ORDER BY calls DESC, last_used DESC, tool_name ASC
					LIMIT ?
				`)
				.all(boundedLimit) as Array<{
				tool_name: string;
				calls: number;
				errors: number | null;
				last_used: number | null;
			}>;
			return rows.map((row) => ({
				tool: row.tool_name,
				calls: row.calls,
				errors: row.errors ?? 0,
				lastUsed: row.last_used ?? 0,
			}));
		},
	};
}
