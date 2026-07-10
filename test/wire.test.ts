import { describe, expect, test } from "bun:test";
import * as mainWire from "../../oh-my-pi/packages/stats/src/reflection-wire.ts";
import * as localWire from "../src/wire.ts";

describe("reflection wire contract", () => {
	test("constants match main-repo reflection-wire.ts exactly", () => {
		expect(localWire.ACTIVITY_REFLECTION_SCHEMA_VERSION).toBe(
			mainWire.ACTIVITY_REFLECTION_SCHEMA_VERSION,
		);
		expect(localWire.ACTIVITY_REFLECTION_START_TYPE).toBe(
			mainWire.ACTIVITY_REFLECTION_START_TYPE,
		);
		expect(localWire.ACTIVITY_REFLECTION_FINISH_TYPE).toBe(
			mainWire.ACTIVITY_REFLECTION_FINISH_TYPE,
		);
		expect(localWire.ACTIVITY_REFLECTION_SIDECAR).toBe(
			mainWire.ACTIVITY_REFLECTION_SIDECAR,
		);
		expect(localWire.ACTIVITY_REFLECTION_SCHEMA_VERSION).toBe(1);
		expect(localWire.ACTIVITY_REFLECTION_START_TYPE).toBe(
			"omp.activity-reflection.start",
		);
		expect(localWire.ACTIVITY_REFLECTION_FINISH_TYPE).toBe(
			"omp.activity-reflection.finish",
		);
		expect(localWire.ACTIVITY_REFLECTION_SIDECAR).toBe("__omp-reflect.jsonl");
	});

	test("start/finish fixtures are assignable both ways", () => {
		const start = {
			attemptId: "att-1",
			schemaVersion: 1,
			sourceSessionId: "sess-1",
			sourceEntryIds: ["e1", "e2"],
			project: "/tmp/project",
			startedAt: 1_700_000_000_000,
			model: { provider: "openai", id: "gpt-4.1", api: "openai-responses" },
		} satisfies localWire.ActivityReflectionAttemptStart satisfies mainWire.ActivityReflectionAttemptStart;

		const finish = {
			attemptId: "att-1",
			schemaVersion: 1,
			status: "success" as const,
			finishedAt: 1_700_000_001_000,
			durationMs: 1000,
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
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
					category: "prompting" as const,
					observation: "Prompt was underspecified",
					evidence: "Task e1 required 3 clarification turns",
					suggestion: "State acceptance criteria up front",
					expectedImpact: "Fewer follow-up turns",
					confidence: "medium" as const,
					sourceEntryIds: ["e1"],
				},
			],
		} satisfies localWire.ActivityReflectionAttemptFinish satisfies mainWire.ActivityReflectionAttemptFinish;

		const startAsMain: mainWire.ActivityReflectionAttemptStart = start;
		const startAsLocal: localWire.ActivityReflectionAttemptStart = startAsMain;
		const finishAsMain: mainWire.ActivityReflectionAttemptFinish = finish;
		const finishAsLocal: localWire.ActivityReflectionAttemptFinish =
			finishAsMain;

		expect(startAsLocal.attemptId).toBe("att-1");
		expect(finishAsLocal.status).toBe("success");
		expect(finishAsLocal.findings).toHaveLength(1);
	});
});
