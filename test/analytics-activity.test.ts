import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildActivityStats } from "../src/analytics/activity.ts";
import { type ActivityDb, openActivityDb } from "../src/analytics/db.ts";
import type { ActivityParseResult } from "../src/analytics/parser.ts";

const tempDirs: string[] = [];
const openDbs: ActivityDb[] = [];

afterEach(() => {
	for (const db of openDbs.splice(0)) db.close();
	for (const dir of tempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function createDb(): ActivityDb {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "omp-reflect-analytics-activity-"),
	);
	tempDirs.push(root);
	const db = openActivityDb(path.join(root, "activity.sqlite"));
	openDbs.push(db);
	return db;
}

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date: Date, days: number): Date {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate() + days,
		12,
	);
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
): void {
	const owner = crypto.randomUUID();
	if (!db.tryClaimLease(owner, 60_000))
		throw new Error("test failed to claim activity lease");
	try {
		db.applyParseResultUnderLease(owner, sessionFile, Date.now(), result);
	} finally {
		db.releaseLease(owner);
	}
}

function localTimestamp(date: Date): number {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		12,
	).getTime();
}

describe("activity statistics", () => {
	test("materializes the 52 Sunday weeks with a lifetime baseline and yesterday-ending streak", () => {
		const db = createDb();
		const now = new Date(2026, 6, 8, 15, 30); // Wednesday; tests local calendar behavior deterministically.
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const currentSunday = addDays(today, -today.getDay());
		const windowStart = addDays(currentSunday, -51 * 7);
		const preWindow = addDays(windowStart, -1);
		const firstWindowDay = windowStart;
		const yesterday = addDays(today, -1);
		const twoDaysAgo = addDays(today, -2);
		const olderRunStart = addDays(today, -12);
		const sessionFile = "/sessions/main.jsonl";
		apply(
			db,
			sessionFile,
			emptyResult({
				messages: [
					{
						sessionFile,
						entryId: "pre-window",
						folder: "/work/demo",
						model: "gpt-5",
						provider: "openai",
						timestamp: localTimestamp(preWindow),
						totalTokens: 100,
						costTotal: 0,
						isError: false,
						thinkingLevel: null,
						priorityRealized: false,
						agentKind: "main",
					},
					{
						sessionFile,
						entryId: "first-window",
						folder: "/work/demo",
						model: "gpt-5",
						provider: "openai",
						timestamp: localTimestamp(firstWindowDay),
						totalTokens: 3,
						costTotal: 0,
						isError: false,
						thinkingLevel: "high",
						priorityRealized: true,
						agentKind: "main",
					},
				],
				tasks: [
					...[
						twoDaysAgo,
						yesterday,
						olderRunStart,
						addDays(olderRunStart, 1),
						addDays(olderRunStart, 2),
					].map((date, index) => ({
						sessionFile,
						entryId: `task-${index}`,
						folder: "/work/demo",
						timestamp: localTimestamp(date),
						agentKind: "main" as const,
					})),
				],
				taskProgress: [
					...[
						twoDaysAgo,
						yesterday,
						olderRunStart,
						addDays(olderRunStart, 1),
						addDays(olderRunStart, 2),
					].map((date, index) => ({
						sessionFile,
						entryId: `task-${index}`,
						completedAt: localTimestamp(date) + 600,
					})),
				],
			}),
		);

		const stats = buildActivityStats(db, now);

		expect(stats.window).toMatchObject({
			start: dayKey(windowStart),
			end: dayKey(today),
		});
		expect(stats.weekly).toHaveLength(52);
		expect(stats.cumulative).toHaveLength(52);
		expect(stats.daily).toHaveLength(51 * 7 + today.getDay() + 1);
		expect(stats.daily[0]).toEqual({
			date: dayKey(windowStart),
			tokens: 3,
			requests: 1,
			tasks: 0,
		});
		expect(stats.daily[1]).toEqual({
			date: dayKey(addDays(windowStart, 1)),
			tokens: 0,
			requests: 0,
			tasks: 0,
		});
		expect(stats.cumulative[0]).toEqual({
			weekStart: dayKey(windowStart),
			totalTokens: 103,
		});
		expect(stats.lifetimeTokens).toBe(103);
		expect(stats.streak).toEqual({ current: 2, longest: 3 });
		expect(stats.priority).toEqual({
			priorityRequests: 1,
			totalRequests: 2,
			percentage: 0.5,
		});
		expect(stats.reasoning).toEqual({
			levels: [{ level: "high", requests: 1, share: 1 }],
			knownRequests: 1,
			totalRequests: 2,
		});
	});

	test("keeps a valid zero-token day as the full-history peak", () => {
		const db = createDb();
		const now = new Date(2026, 6, 8, 15, 30);
		const timestamp = localTimestamp(addDays(now, -400));
		const sessionFile = "/sessions/zero.jsonl";
		apply(
			db,
			sessionFile,
			emptyResult({
				messages: [
					{
						sessionFile,
						entryId: "zero-usage",
						folder: "/work/demo",
						model: "gpt-5",
						provider: "openai",
						timestamp,
						totalTokens: 0,
						costTotal: 0,
						isError: false,
						thinkingLevel: null,
						priorityRealized: false,
						agentKind: "main",
					},
				],
			}),
		);

		const stats = buildActivityStats(db, now);

		expect(stats.peakDay).toEqual({
			date: dayKey(new Date(timestamp)),
			tokens: 0,
		});
		expect(stats.priority).toEqual({
			priorityRequests: 0,
			totalRequests: 1,
			percentage: 0,
		});
	});

	test("uses a null priority percentage only when there are no requests", () => {
		const stats = buildActivityStats(createDb(), new Date(2026, 6, 8, 15, 30));

		expect(stats.totalRequests).toBe(0);
		expect(stats.priority).toEqual({
			priorityRequests: 0,
			totalRequests: 0,
			percentage: null,
		});
		expect(stats.peakDay).toBeNull();
	});
});
