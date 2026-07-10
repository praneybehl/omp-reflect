import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ActivityDb,
	ActivityLeaseLostError,
	openActivityDb,
} from "../src/analytics/db.ts";
import {
	type ActivityParseResult,
	parseActivitySession,
} from "../src/analytics/parser.ts";
import { syncActivity } from "../src/analytics/sync.ts";
import {
	ACTIVITY_REFLECTION_FINISH_TYPE,
	ACTIVITY_REFLECTION_SCHEMA_VERSION,
	ACTIVITY_REFLECTION_SIDECAR,
	ACTIVITY_REFLECTION_START_TYPE,
} from "../src/wire.ts";

const tempDirs: string[] = [];
const openDbs: ActivityDb[] = [];

afterEach(() => {
	for (const db of openDbs.splice(0)) db.close();
	for (const dir of tempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function createTempRoot(): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "omp-reflect-analytics-db-"),
	);
	tempDirs.push(root);
	return root;
}

function createDb(root: string): ActivityDb {
	const db = openActivityDb(path.join(root, "activity.sqlite"));
	openDbs.push(db);
	return db;
}

function emptyResult(
	patch: Partial<ActivityParseResult> = {},
): ActivityParseResult {
	return {
		messages: [],
		tasks: [],
		taskProgress: [],
		skills: [],
		toolCalls: [],
		toolResults: [],
		reflections: [],
		newOffset: 0,
		...patch,
	};
}

function apply(
	db: ActivityDb,
	sessionFile: string,
	result: ActivityParseResult,
): number {
	const owner = crypto.randomUUID();
	if (!db.tryClaimLease(owner, 60_000))
		throw new Error("test failed to claim activity lease");
	try {
		return db.applyParseResultUnderLease(
			owner,
			sessionFile,
			Date.now(),
			result,
		);
	} finally {
		db.releaseLease(owner);
	}
}

function localDayKey(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function writeJsonl(file: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
}

describe("activity database", () => {
	test("deduplicates forked assistant entries by entry id and timestamp", () => {
		const root = createTempRoot();
		const db = createDb(root);
		const timestamp = Date.parse("2026-07-10T12:00:00.000Z");
		const first = path.join(root, "parent.jsonl");
		const fork = path.join(root, "fork.jsonl");
		const message = {
			entryId: "shared-entry",
			folder: "/work/demo",
			model: "gpt-5",
			provider: "openai",
			timestamp,
			totalTokens: 77,
			costTotal: 0.07,
			isError: false,
			thinkingLevel: "high",
			priorityRealized: false,
			agentKind: "main" as const,
		};

		expect(
			apply(
				db,
				first,
				emptyResult({ messages: [{ ...message, sessionFile: first }] }),
			),
		).toBe(1);
		expect(
			apply(
				db,
				fork,
				emptyResult({ messages: [{ ...message, sessionFile: fork }] }),
			),
		).toBe(0);
		expect(db.dayRollup()).toEqual([
			{ date: localDayKey(timestamp), tokens: 77, requests: 1 },
		]);
	});

	test("rejects stale lease writes before rows or offsets change", () => {
		const root = createTempRoot();
		const stale = createDb(root);
		const current = createDb(root);
		const staleOwner = "stale-owner";
		const currentOwner = "current-owner";
		expect(stale.tryClaimLease(staleOwner, 0)).toBe(true);
		expect(current.tryClaimLease(currentOwner, 60_000)).toBe(true);
		const sessionFile = path.join(root, "stale.jsonl");

		expect(() =>
			stale.applyParseResultUnderLease(
				staleOwner,
				sessionFile,
				1,
				emptyResult({
					messages: [
						{
							sessionFile,
							entryId: "must-not-write",
							folder: "/work/demo",
							model: "gpt-5",
							provider: "openai",
							timestamp: 1,
							totalTokens: 1,
							costTotal: 0,
							isError: false,
							thinkingLevel: null,
							priorityRealized: false,
							agentKind: "main",
						},
					],
				}),
			),
		).toThrow(ActivityLeaseLostError);
		expect(current.dayRollup()).toEqual([]);
		expect(current.getOffset(sessionFile)).toBeNull();
		current.releaseLease(currentOwner);
	});

	test("persists folded reflection findings and bills their reported usage", async () => {
		const root = createTempRoot();
		const sessionsDir = path.join(root, "sessions");
		const sidecar = path.join(
			sessionsDir,
			"--work--demo--",
			"session",
			ACTIVITY_REFLECTION_SIDECAR,
		);
		const db = createDb(root);
		const startedAt = Date.parse("2026-07-10T08:00:00.000Z");
		const finishedAt = startedAt + 5_000;
		writeJsonl(sidecar, [
			{
				type: "custom",
				customType: ACTIVITY_REFLECTION_START_TYPE,
				data: {
					schemaVersion: ACTIVITY_REFLECTION_SCHEMA_VERSION,
					attemptId: "reflection-1",
					sourceSessionId: "session-1",
					sourceEntryIds: ["task-1"],
					project: "/work/demo",
					startedAt,
					model: { provider: "openai", id: "gpt-5", api: "openai-responses" },
				},
			},
			{
				type: "custom",
				customType: ACTIVITY_REFLECTION_FINISH_TYPE,
				data: {
					schemaVersion: ACTIVITY_REFLECTION_SCHEMA_VERSION,
					attemptId: "reflection-1",
					status: "success",
					finishedAt,
					durationMs: 5_000,
					usage: {
						input: 6,
						output: 7,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 13,
						cost: {
							input: 0.01,
							output: 0.02,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0.03,
						},
					},
					findings: [
						{
							category: "tools",
							observation: "Observation",
							evidence: "Evidence",
							suggestion: "Suggestion",
							expectedImpact: "Impact",
							confidence: "medium",
							sourceEntryIds: ["task-1"],
						},
					],
				},
			},
		]);
		const parsed = await parseActivitySession(sidecar, 0, sessionsDir);

		expect(apply(db, sidecar, parsed)).toBe(1);
		expect(db.dayRollup()).toEqual([
			{ date: localDayKey(finishedAt), tokens: 13, requests: 1 },
		]);
		expect(db.reflectionFeed(10)).toEqual([
			{
				attemptId: "reflection-1",
				category: "tools",
				observation: "Observation",
				evidence: "Evidence",
				suggestion: "Suggestion",
				expectedImpact: "Impact",
				confidence: "medium",
				project: "/work/demo",
				model: "gpt-5",
				provider: "openai",
				finishedAt,
			},
		]);
	});

	test("keeps confirmed root reads confirmed when a later result errors", () => {
		const root = createTempRoot();
		const db = createDb(root);
		const sessionFile = path.join(root, "session.jsonl");
		const timestamp = Date.parse("2026-07-10T09:00:00.000Z");
		apply(
			db,
			sessionFile,
			emptyResult({
				skills: [
					{
						sessionFile,
						entryId: "assistant-1",
						toolCallId: "read-1",
						skillName: "release",
						source: "read",
						timestamp,
						confirmed: false,
					},
				],
			}),
		);
		apply(
			db,
			sessionFile,
			emptyResult({
				toolResults: [{ sessionFile, toolCallId: "read-1", isError: false }],
			}),
		);
		apply(
			db,
			sessionFile,
			emptyResult({
				toolResults: [{ sessionFile, toolCallId: "read-1", isError: true }],
			}),
		);

		expect(db.skillUsage()).toEqual([
			{ skill: "release", uses: 1, share: 1, lastUsed: timestamp },
		]);
	});

	test("waits for a held lease, then syncs after release", async () => {
		const root = createTempRoot();
		const sessionsDir = path.join(root, "sessions");
		const sessionFile = path.join(
			sessionsDir,
			"--work--demo--",
			"session.jsonl",
		);
		writeJsonl(sessionFile, [
			{
				type: "message",
				id: "assistant-1",
				timestamp: "2026-07-10T10:00:00.000Z",
				message: {
					role: "assistant",
					model: "gpt-5",
					provider: "openai",
					api: "openai-responses",
					timestamp: Date.parse("2026-07-10T10:00:00.000Z"),
					usage: { totalTokens: 1, cost: { total: 0 } },
					content: [],
				},
			},
		]);
		const holder = createDb(root);
		const waiter = createDb(root);
		expect(holder.tryClaimLease("holder", 60_000)).toBe(true);
		let settled = false;
		const firstPoll = Promise.withResolvers<void>();
		const resumePolling = Promise.withResolvers<void>();
		const pending = syncActivity(waiter, {
			sessionsDir,
			pollMs: 1,
			waitMs: 1_000,
			sleep: () => {
				firstPoll.resolve();
				return resumePolling.promise;
			},
		}).then((result) => {
			settled = true;
			return result;
		});
		await firstPoll.promise;
		expect(settled).toBe(false);
		holder.releaseLease("holder");
		resumePolling.resolve();
		expect(await pending).toEqual({ processed: 1, files: 1 });
	});

	test("reconciles an ENOENT owner before parsing its surviving moved session once", async () => {
		const root = createTempRoot();
		const sessionsDir = path.join(root, "sessions");
		const survivor = path.join(sessionsDir, "--work--demo--", "moved.jsonl");
		const missing = path.join(root, "gone.jsonl");
		const timestamp = Date.parse("2026-07-10T13:00:00.000Z");
		writeJsonl(survivor, [
			{
				type: "message",
				id: "moved-entry",
				timestamp: "2026-07-10T13:00:00.000Z",
				message: {
					role: "assistant",
					model: "gpt-5",
					provider: "openai",
					api: "openai-responses",
					timestamp,
					usage: { totalTokens: 9, cost: { total: 0 } },
					content: [],
				},
			},
		]);
		const db = createDb(root);
		apply(
			db,
			missing,
			emptyResult({
				messages: [
					{
						sessionFile: missing,
						entryId: "moved-entry",
						folder: "/work/demo",
						model: "gpt-5",
						provider: "openai",
						timestamp,
						totalTokens: 9,
						costTotal: 0,
						isError: false,
						thinkingLevel: null,
						priorityRealized: false,
						agentKind: "main",
					},
				],
			}),
		);

		expect(await syncActivity(db, { sessionsDir })).toEqual({
			processed: 1,
			files: 1,
		});
		expect(db.listKnownOwners()).toEqual([survivor]);
		expect(db.dayRollup()).toEqual([
			{ date: localDayKey(timestamp), tokens: 9, requests: 1 },
		]);
		expect(await syncActivity(db, { sessionsDir })).toEqual({
			processed: 0,
			files: 0,
		});
		expect(db.dayRollup()).toEqual([
			{ date: localDayKey(timestamp), tokens: 9, requests: 1 },
		]);
	});
	test("leaves an owner intact when stat fails for a non-ENOENT reason", async () => {
		const root = createTempRoot();
		const db = createDb(root);
		const unreadable = path.join(root, "unreadable.jsonl");
		// Midday-safe anchor: bun test pins JS Date to TZ=UTC while bun:sqlite's
		// 'localtime' keeps the OS zone, so a timestamp near midnight in either
		// zone would make the two calendars disagree. 02:00Z is the same local
		// date in UTC and UTC+10/11; the date value is incidental to this
		// test's contract (non-ENOENT stat must not reclaim the owner).
		const timestamp = Date.parse("2026-07-10T02:00:00.000Z");
		apply(
			db,
			unreadable,
			emptyResult({
				messages: [
					{
						sessionFile: unreadable,
						entryId: "keep-on-eacces",
						folder: "/work/demo",
						model: "gpt-5",
						provider: "openai",
						timestamp,
						totalTokens: 4,
						costTotal: 0,
						isError: false,
						thinkingLevel: null,
						priorityRealized: false,
						agentKind: "main",
					},
				],
			}),
		);
		const denied = Object.assign(new Error("permission denied"), {
			code: "EACCES",
		});

		expect(
			await syncActivity(db, {
				listFiles: async () => [],
				stat: async () => {
					throw denied;
				},
			}),
		).toEqual({ processed: 0, files: 0 });
		expect(db.listKnownOwners()).toEqual([unreadable]);
		expect(db.dayRollup()).toEqual([
			{ date: localDayKey(timestamp), tokens: 4, requests: 1 },
		]);
	});
});
