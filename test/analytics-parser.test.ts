import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseActivitySession } from "../src/analytics/parser.ts";
import {
	ACTIVITY_REFLECTION_FINISH_TYPE,
	ACTIVITY_REFLECTION_SCHEMA_VERSION,
	ACTIVITY_REFLECTION_SIDECAR,
	ACTIVITY_REFLECTION_START_TYPE,
} from "../src/wire.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function createSessionsDir(): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "omp-reflect-analytics-parser-"),
	);
	tempDirs.push(root);
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });
	return sessionsDir;
}

function writeJsonl(file: string, entries: unknown[]): number {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const body = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	fs.writeFileSync(file, body);
	return new TextEncoder().encode(body).byteLength;
}

describe("activity session parser", () => {
	test("recovers thinking and an image-only open task from an incremental prefix", async () => {
		const sessionsDir = createSessionsDir();
		const sessionFile = path.join(sessionsDir, "--work--demo--", "main.jsonl");
		const assistantAt = Date.parse("2026-07-10T12:00:00.000Z");
		const prefix = [
			{ type: "service_tier_change", serviceTier: "priority" },
			{
				type: "thinking_level_change",
				thinkingLevel: "high",
				configured: "high",
			},
			{
				type: "message",
				id: "task-image",
				timestamp: "2026-07-10T11:59:00.000Z",
				message: { role: "user", content: [{ type: "image" }] },
			},
		];
		const tail = [
			{
				type: "message",
				id: "assistant-1",
				timestamp: "2026-07-10T12:00:01.000Z",
				message: {
					role: "assistant",
					model: "gpt-5",
					provider: "openai",
					api: "openai-responses",
					timestamp: assistantAt,
					duration: 250,
					stopReason: "stop",
					usage: { totalTokens: 42, cost: { total: 0.12 } },
					content: [],
				},
			},
			{
				type: "message",
				id: "tool-result-1",
				timestamp: "2026-07-10T12:10:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "unrelated-call",
					timestamp: assistantAt + 1_000,
					isError: false,
					content: [],
				},
			},
		];
		const prefixBytes = new TextEncoder().encode(
			`${prefix.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		).byteLength;
		writeJsonl(sessionFile, [...prefix, ...tail]);

		const parsed = await parseActivitySession(
			sessionFile,
			prefixBytes,
			sessionsDir,
		);

		expect(parsed.tasks).toEqual([]);
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.messages[0]?.thinkingLevel).toBe("high");
		expect(parsed.taskProgress).toEqual([
			{
				sessionFile,
				entryId: "task-image",
				completedAt: assistantAt + 1_000,
			},
		]);
		expect(parsed.newOffset).toBe(fs.statSync(sessionFile).size);
	});

	test("records custom skill prompts and only confirms exact-root reads", async () => {
		const sessionsDir = createSessionsDir();
		const sessionFile = path.join(sessionsDir, "--work--demo--", "main.jsonl");
		writeJsonl(sessionFile, [
			{
				type: "custom_message",
				id: "skill-prompt",
				timestamp: "2026-07-10T10:00:00.000Z",
				customType: "skill-prompt",
				details: { name: "  release  " },
			},
			{
				type: "message",
				id: "assistant-tools",
				timestamp: "2026-07-10T10:01:00.000Z",
				message: {
					role: "assistant",
					model: "gpt-5",
					provider: "openai",
					api: "openai-responses",
					timestamp: Date.parse("2026-07-10T10:01:00.000Z"),
					usage: { totalTokens: 1, cost: { total: 0 } },
					content: [
						{
							type: "toolCall",
							id: "root-ok",
							name: "read",
							arguments: { path: "skill://release" },
						},
						{
							type: "toolCall",
							id: "root-pending",
							name: "read",
							arguments: { path: "skill://review" },
						},
						{
							type: "toolCall",
							id: "root-error",
							name: "read",
							arguments: { path: "skill://broken" },
						},
						{
							type: "toolCall",
							id: "nested",
							name: "read",
							arguments: { path: "skill://release/docs.md" },
						},
						{
							type: "toolCall",
							id: "selector",
							name: "read",
							arguments: { path: "skill://release:3" },
						},
						{
							type: "toolCall",
							id: "query",
							name: "read",
							arguments: { path: "skill://release?draft=1" },
						},
						{
							type: "toolCall",
							id: "fragment",
							name: "read",
							arguments: { path: "skill://release#intro" },
						},
					],
				},
			},
			{
				type: "message",
				id: "result-ok",
				timestamp: "2026-07-10T10:01:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "root-ok",
					isError: false,
					content: [],
				},
			},
			{
				type: "message",
				id: "result-error",
				timestamp: "2026-07-10T10:01:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "root-error",
					isError: true,
					content: [],
				},
			},
		]);

		const parsed = await parseActivitySession(sessionFile, 0, sessionsDir);

		expect(
			parsed.skills.map((skill) => [
				skill.skillName,
				skill.source,
				skill.confirmed,
			]),
		).toEqual([
			["release", "prompt", true],
			["release", "read", true],
			["review", "read", false],
		]);
		expect(parsed.toolCalls).toHaveLength(7);
		expect(parsed.toolResults).toEqual([
			{ sessionFile, toolCallId: "root-ok", isError: false },
			{ sessionFile, toolCallId: "root-error", isError: true },
		]);
	});

	test("folds only matched v1 reflection sidecar entries and emits billed usage", async () => {
		const sessionsDir = createSessionsDir();
		const sidecar = path.join(
			sessionsDir,
			"--work--demo--",
			"session",
			ACTIVITY_REFLECTION_SIDECAR,
		);
		const startedAt = Date.parse("2026-07-10T08:00:00.000Z");
		const finishedAt = startedAt + 2_500;
		writeJsonl(sidecar, [
			{
				type: "custom",
				customType: ACTIVITY_REFLECTION_START_TYPE,
				data: {
					schemaVersion: ACTIVITY_REFLECTION_SCHEMA_VERSION,
					attemptId: "attempt-1",
					sourceSessionId: "source-1",
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
					attemptId: "attempt-1",
					status: "success",
					finishedAt,
					durationMs: 2_500,
					usage: {
						input: 12,
						output: 8,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
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
							category: "workflow",
							observation: "Valid observation",
							evidence: "Valid evidence",
							suggestion: "Valid suggestion",
							expectedImpact: "Valid impact",
							confidence: "high",
							sourceEntryIds: ["task-1"],
						},
						{ category: "unknown", confidence: "high" },
					],
				},
			},
		]);

		const parsed = await parseActivitySession(sidecar, 0, sessionsDir);

		expect(parsed.messages).toEqual([
			expect.objectContaining({
				entryId: "attempt-1",
				totalTokens: 20,
				costTotal: 0.03,
				agentKind: "reflection",
			}),
		]);
		expect(parsed.reflections).toEqual([
			expect.objectContaining({
				attemptId: "attempt-1",
				sourceSessionId: "source-1",
				findings: [expect.any(Object)],
			}),
		]);
	});
});
