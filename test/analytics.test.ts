import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildActivityStats,
	computeStreaks,
} from "../src/analytics/activity.ts";
import { ActivityLeaseLostError, openActivityDb } from "../src/analytics/db.ts";
import {
	classifyAgentKind,
	parseActivitySession,
} from "../src/analytics/parser.ts";
import { syncActivity } from "../src/analytics/sync.ts";
import {
	ACTIVITY_REFLECTION_FINISH_TYPE,
	ACTIVITY_REFLECTION_SIDECAR,
	ACTIVITY_REFLECTION_START_TYPE,
} from "../src/wire.ts";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

/** Isolated sessions root + activity DB. */
function fixture(): { sessionsDir: string; dbPath: string } {
	const dir = tempDir("omp-reflect-analytics-");
	const sessionsDir = path.join(dir, "sessions");
	fs.mkdirSync(path.join(sessionsDir, "--tmp--proj"), { recursive: true });
	return { sessionsDir, dbPath: path.join(dir, "activity.sqlite") };
}

const iso = (ms: number) => new Date(ms).toISOString();

function assistantLine(
	id: string,
	parentId: string | null,
	ts: number,
	extra?: Record<string, unknown>,
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: iso(ts),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 5,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
			stopReason: "stop",
			timestamp: ts,
			duration: 2_000,
			...extra,
		},
	});
}

function userLine(
	id: string,
	ts: number,
	content: unknown = "do the thing",
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: iso(ts),
		message: { role: "user", content },
	});
}

describe("parser", () => {
	test("classifies transcripts by path", () => {
		const root = "/tmp/sessions";
		expect(classifyAgentKind("/tmp/sessions/--p--/a.jsonl", root)).toBe("main");
		expect(classifyAgentKind("/tmp/sessions/--p--/a/sub.jsonl", root)).toBe(
			"subagent",
		);
		expect(
			classifyAgentKind("/tmp/sessions/--p--/a/__advisor.jsonl", root),
		).toBe("advisor");
		expect(
			classifyAgentKind(
				`/tmp/sessions/--p--/a/${ACTIVITY_REFLECTION_SIDECAR}`,
				root,
			),
		).toBe("reflection");
	});

	test("extracts messages, task windows, thinking, and skills with prefix recovery", async () => {
		const { sessionsDir } = fixture();
		const file = path.join(sessionsDir, "--tmp--proj", "s.jsonl");
		const t0 = Date.UTC(2026, 0, 5, 10, 0, 0);
		const part1 = `${[
			JSON.stringify({
				type: "thinking_level_change",
				id: "th1",
				timestamp: iso(t0),
				thinkingLevel: "high",
			}),
			userLine("u1", t0 + 1_000),
			JSON.stringify({
				type: "custom_message",
				id: "sp1",
				parentId: "u1",
				timestamp: iso(t0 + 1_500),
				customType: "skill-prompt",
				details: { name: "reviewer" },
			}),
		].join("\n")}\n`;
		await Bun.write(file, part1);
		const first = await parseActivitySession(file, 0, sessionsDir);
		expect(first.messages).toHaveLength(0);
		expect(first.tasks.map((t) => t.entryId)).toEqual(["u1"]);
		expect(first.skills).toEqual([
			expect.objectContaining({
				skillName: "reviewer",
				source: "prompt",
				confirmed: true,
			}),
		]);

		// Incremental tail: thinking level and the open task window must be
		// recovered from the prefix scan.
		const part2 = `${[
			assistantLine("a1", "u1", t0 + 10_000, {
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "read",
						arguments: { path: "skill://drizzle-expert" },
					},
					{
						type: "toolCall",
						id: "c2",
						name: "read",
						arguments: { path: "skill://nope?x=1" },
					},
				],
				stopReason: "toolUse",
			}),
			JSON.stringify({
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: iso(t0 + 30_000),
				message: {
					role: "toolResult",
					toolCallId: "c1",
					content: [],
					isError: false,
					timestamp: t0 + 20_000,
				},
			}),
		].join("\n")}\n`;
		fs.appendFileSync(file, part2);
		const second = await parseActivitySession(
			file,
			first.newOffset,
			sessionsDir,
		);

		expect(second.messages).toHaveLength(1);
		expect(second.messages[0].thinkingLevel).toBe("high"); // prefix recovery
		// Root read confirmed; query-suffixed read rejected entirely.
		expect(second.skills).toEqual([
			expect.objectContaining({
				skillName: "drizzle-expert",
				source: "read",
				confirmed: true,
			}),
		]);
		// Task window recovered from prefix: completion = nested tool-result
		// execution timestamp (t0+20s), not persistence time (t0+30s).
		expect(second.taskProgress).toEqual([
			expect.objectContaining({ entryId: "u1", completedAt: t0 + 20_000 }),
		]);
	});

	test("folds reflection sidecars into feed rows and a billed usage row", async () => {
		const { sessionsDir } = fixture();
		const artifacts = path.join(sessionsDir, "--tmp--proj", "s");
		fs.mkdirSync(artifacts, { recursive: true });
		const sidecar = path.join(artifacts, ACTIVITY_REFLECTION_SIDECAR);
		const t0 = Date.UTC(2026, 0, 6, 9, 0, 0);
		const finding = {
			category: "workflow",
			observation: "obs",
			evidence: "ev",
			suggestion: "sug",
			expectedImpact: "imp",
			confidence: "low",
			sourceEntryIds: ["u1"],
		};
		await Bun.write(
			sidecar,
			`${[
				JSON.stringify({
					type: "custom",
					id: "c1",
					timestamp: iso(t0),
					customType: ACTIVITY_REFLECTION_START_TYPE,
					data: {
						attemptId: "att-1",
						schemaVersion: 1,
						sourceSessionId: "s",
						sourceEntryIds: ["u1"],
						project: "/tmp/p",
						startedAt: t0,
						model: {
							provider: "openai",
							id: "gpt-test",
							api: "openai-responses",
						},
					},
				}),
				JSON.stringify({
					type: "custom",
					id: "c2",
					timestamp: iso(t0 + 10_000),
					customType: ACTIVITY_REFLECTION_FINISH_TYPE,
					data: {
						attemptId: "att-1",
						schemaVersion: 1,
						status: "success",
						finishedAt: t0 + 10_000,
						durationMs: 10_000,
						usage: {
							input: 1,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 500,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0.05,
							},
						},
						findings: [finding],
					},
				}),
			].join("\n")}\n`,
		);

		const parsed = await parseActivitySession(sidecar, 0, sessionsDir);
		expect(parsed.reflections).toHaveLength(1);
		expect(parsed.reflections[0].findings).toHaveLength(1);
		// Reflection usage is billed activity: a messages row with the attempt id.
		expect(parsed.messages).toEqual([
			expect.objectContaining({
				entryId: "att-1",
				agentKind: "reflection",
				totalTokens: 500,
			}),
		]);
	});
});

describe("db + sync", () => {
	test("fork copies are first-write deduplicated; deleted owners are reclaimed by survivors", async () => {
		const { sessionsDir, dbPath } = fixture();
		const projDir = path.join(sessionsDir, "--tmp--proj");
		const t0 = Date.UTC(2026, 0, 7, 8, 0, 0);
		const original = path.join(projDir, "orig.jsonl");
		const body =
			[userLine("u1", t0), assistantLine("a1", "u1", t0 + 5_000)].join("\n") +
			"\n";
		await Bun.write(original, body);

		const db = openActivityDb(dbPath);
		try {
			await syncActivity(db, { sessionsDir });
			// Fork: identical entries under a new file — must not double-count.
			const forked = path.join(projDir, "fork.jsonl");
			await Bun.write(forked, body);
			await syncActivity(db, { sessionsDir });
			expect(db.priorityCounts().totalRequests).toBe(1);

			// Delete the original: the fork reclaims ownership, still one row.
			fs.rmSync(original);
			await syncActivity(db, { sessionsDir });
			expect(db.priorityCounts().totalRequests).toBe(1);
			expect(db.listKnownOwners()).toEqual([forked]);
		} finally {
			db.close();
		}
	});

	test("stale lease owners cannot write", () => {
		const { dbPath } = fixture();
		const db = openActivityDb(dbPath);
		try {
			expect(db.tryClaimLease("owner-a", 60_000)).toBe(true);
			expect(db.tryClaimLease("owner-b", 60_000)).toBe(false);
			expect(() =>
				db.applyParseResultUnderLease("owner-b", "/nope.jsonl", 1, {
					messages: [],
					tasks: [],
					taskProgress: [],
					skills: [],
					toolCalls: [],
					toolResults: [],
					reflections: [],
					newOffset: 0,
				}),
			).toThrow(ActivityLeaseLostError);
			db.releaseLease("owner-a");
			expect(db.tryClaimLease("owner-b", 1_000)).toBe(true);
			db.releaseLease("owner-b");
		} finally {
			db.close();
		}
	});
});

describe("activity stats", () => {
	test("window, baseline, peak, streaks, and rankings from synced data", async () => {
		const { sessionsDir, dbPath } = fixture();
		const projDir = path.join(sessionsDir, "--tmp--proj");
		const now = new Date(2026, 6, 10, 12, 0, 0); // local Fri
		const dayMs = 24 * 60 * 60 * 1000;
		const today = now.getTime();
		const lines = `${[
			// Pre-window activity (400 days back) -> cumulative baseline only.
			userLine("u0", today - 400 * dayMs),
			assistantLine("a0", "u0", today - 400 * dayMs + 1_000),
			// Yesterday + today -> a 2-day current streak.
			userLine("u1", today - dayMs),
			assistantLine("a1", "u1", today - dayMs + 1_000),
			userLine("u2", today),
			assistantLine("a2", "u2", today + 1_000),
		].join("\n")}\n`;
		await Bun.write(path.join(projDir, "s.jsonl"), lines);

		const db = openActivityDb(dbPath);
		try {
			await syncActivity(db, { sessionsDir });
			const stats = buildActivityStats(db, now);

			expect(stats.totalRequests).toBe(3);
			expect(stats.lifetimeTokens).toBe(300);
			expect(stats.weekly).toHaveLength(52);
			// Window starts on a Sunday and the daily series is gapless.
			expect(new Date(`${stats.window.start}T12:00:00`).getDay()).toBe(0);
			expect(stats.daily.at(-1)?.date).toBe(stats.window.end);
			// Baseline: the 400-day-old 100 tokens appear in cumulative, not daily.
			const windowTokens = stats.daily.reduce((sum, d) => sum + d.tokens, 0);
			expect(windowTokens).toBe(200);
			expect(stats.cumulative.at(-1)?.totalTokens).toBe(300);
			expect(stats.streak).toEqual({ current: 2, longest: 2 });
			expect(stats.totalTasks).toBe(3);
			expect(stats.models[0]).toMatchObject({
				model: "gpt-test",
				requests: 3,
				totalTokens: 300,
			});
			expect(stats.priority.percentage).toBe(0);
		} finally {
			db.close();
		}
	});

	test("streak may end yesterday; longest run is historical", () => {
		const today = new Date(2026, 6, 10);
		const key = (d: Date) =>
			`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		const day = (offset: number) => key(new Date(2026, 6, 10 + offset));
		// Active yesterday and the day before, plus an older 3-day run.
		const active = new Set([day(-1), day(-2), day(-30), day(-31), day(-32)]);
		expect(computeStreaks(active, today)).toEqual({ current: 2, longest: 3 });
	});
});
