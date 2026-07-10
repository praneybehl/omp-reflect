import { describe, expect, test } from "bun:test";
import type {
	BehaviorDashboardStats,
	BehaviorModelStats,
	GainDashboardStats,
	ToolDashboardStats,
	ToolModelStats,
	ToolUsageStats,
} from "@oh-my-pi/omp-stats/types";
import type {
	ExtensionStats,
	HostExtensionContext,
	HostModelStats,
} from "../src/host-stats.ts";
import { HOST_STATS_REQUIRED_ERROR } from "../src/host-stats.ts";
import {
	boundWithActiveReservation,
	buildObservabilitySnapshotFromAggregates,
	fetchObservabilitySnapshot,
	OBSERVABILITY_RANGES,
} from "../src/observability.ts";

function behaviorModel(
	provider: string,
	model: string,
	messages: number,
): BehaviorModelStats {
	return {
		model,
		provider,
		totalMessages: messages,
		totalYelling: 0,
		totalProfanity: 0,
		totalAnguish: 0,
		totalNegation: 0,
		totalRepetition: 0,
		totalBlame: 0,
		totalChars: messages * 10,
		lastTimestamp: messages,
	};
}

function hostModel(
	provider: string,
	model: string,
	requests: number,
	totalTokens = requests * 100,
): HostModelStats {
	return {
		model,
		provider,
		totalRequests: requests,
		successfulRequests: requests,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: totalTokens / 2,
		totalOutputTokens: totalTokens / 2,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		cacheRate: 0,
		totalCost: 0,
		totalPremiumRequests: 0,
		avgDuration: 1,
		avgTtft: 1,
		avgTokensPerSecond: 1,
		firstTimestamp: 1,
		lastTimestamp: 2,
		totalTokens,
	};
}

function tool(name: string, calls: number): ToolUsageStats {
	return {
		tool: name,
		calls,
		errors: 0,
		argsChars: calls * 10,
		resultChars: calls * 20,
		totalTokensShare: calls,
		outputTokensShare: calls,
		costShare: 0,
		lastUsed: calls,
	};
}

function toolModel(
	provider: string,
	model: string,
	name: string,
	calls: number,
): ToolModelStats {
	return { ...tool(name, calls), model, provider };
}

function behaviorDash(byModel: BehaviorModelStats[]): BehaviorDashboardStats {
	return {
		overall: {
			totalMessages: byModel.reduce((s, r) => s + r.totalMessages, 0),
			totalYelling: 0,
			totalProfanity: 0,
			totalAnguish: 0,
			totalNegation: 0,
			totalRepetition: 0,
			totalBlame: 0,
			totalChars: 0,
			firstTimestamp: 0,
			lastTimestamp: 0,
		},
		byModel,
		behaviorSeries: [],
	};
}

function toolsDash(
	byTool: ToolUsageStats[],
	byToolModel: ToolModelStats[],
): ToolDashboardStats {
	return { byTool, byToolModel, series: [] };
}

function gainDash(): GainDashboardStats {
	return {
		overall: {
			savedTokens: 42,
			savedBytes: 100,
			hits: 3,
			outputBytes: 50,
			originalBytes: 150,
			reductionPercent: 0.66,
		},
		bySource: {
			snapcompact: {
				savedTokens: 42,
				savedBytes: 100,
				hits: 3,
				outputBytes: 50,
				originalBytes: 150,
				reductionPercent: 0.66,
			},
		},
		timeSeries: [],
		project: "/proj",
		projects: ["/proj"],
	};
}

describe("boundWithActiveReservation", () => {
	test("keeps top-N by score and reserves active model", () => {
		const rows = Array.from({ length: 12 }, (_, i) => ({
			id: `m${i}`,
			score: 12 - i,
		}));
		const active = { id: "m11", score: 1 };
		const bound = boundWithActiveReservation(
			rows,
			(r) => r.score,
			(r) => r.id === active.id,
			8,
		);
		expect(bound).toHaveLength(8);
		expect(bound.some((r) => r.id === "m11")).toBe(true);
		expect(bound[0]!.id).toBe("m0");
	});
});

describe("buildObservabilitySnapshotFromAggregates", () => {
	test("enforces active-model reservation and top-N bounds while preserving row fields", () => {
		const behaviorModels = Array.from({ length: 12 }, (_, i) =>
			behaviorModel("p", `m${i}`, 100 - i),
		);
		// Active model has low message count so it would fall outside top-8 without reservation.
		behaviorModels.push(behaviorModel("openai", "gpt-active", 1));

		const models = Array.from({ length: 12 }, (_, i) =>
			hostModel("p", `m${i}`, 100 - i, (100 - i) * 10),
		);
		models.push(hostModel("openai", "gpt-active", 1, 999));

		const tools = Array.from({ length: 20 }, (_, i) => tool(`t${i}`, 50 - i));
		const toolModels = [
			...Array.from({ length: 20 }, (_, i) =>
				toolModel("p", `m${i}`, `t${i}`, 50 - i),
			),
			toolModel("openai", "gpt-active", "special", 1),
		];

		const snap = buildObservabilitySnapshotFromAggregates({
			behavior30d: behaviorDash(behaviorModels),
			behaviorAll: behaviorDash(behaviorModels),
			modelsAll: { byModel: models },
			tools30d: toolsDash(tools, toolModels),
			gainOverall: gainDash().overall,
			activeModel: { provider: "openai", id: "gpt-active" },
		});

		expect(snap.status).toBe("ok");
		expect(snap.behaviorModels30d).toHaveLength(8);
		expect(snap.behaviorModels30d!.some((r) => r.model === "gpt-active")).toBe(
			true,
		);
		expect(
			snap.behaviorModels30d!.find((r) => r.model === "gpt-active")!
				.totalMessages,
		).toBe(1);

		expect(snap.modelsAll).toHaveLength(8);
		const activeHost = snap.modelsAll!.find((r) => r.model === "gpt-active");
		expect(activeHost).toBeDefined();
		expect(activeHost!.totalTokens).toBe(999);

		expect(snap.tools30d).toHaveLength(12);
		expect(snap.tools30d![0]!.tool).toBe("t0");
		expect(snap.tools30d![0]!.calls).toBe(50);

		// Active-model tool rows only.
		expect(snap.toolModels30d!.every((r) => r.model === "gpt-active")).toBe(
			true,
		);
		expect(snap.toolModels30d![0]!.tool).toBe("special");

		expect(snap.gainOverall!.savedTokens).toBe(42);
		expect(snap.behavior30d!.totalMessages).toBe(
			behaviorModels.reduce((s, r) => s + r.totalMessages, 0),
		);
	});
});

describe("fetchObservabilitySnapshot", () => {
	test("injected facade receives exact ranges and project cwd", async () => {
		const calls: Array<{ method: string; args: unknown[] }> = [];
		const behaviorModels = [behaviorModel("openai", "gpt", 20)];
		const models = [hostModel("openai", "gpt", 20, 2000)];
		const tools = [tool("bash", 5)];
		const toolModels = [toolModel("openai", "gpt", "bash", 5)];
		const gain = gainDash();

		const stats: ExtensionStats = {
			async sync() {
				calls.push({ method: "sync", args: [] });
				return { processed: 3, files: 2 };
			},
			async behavior(range) {
				calls.push({ method: "behavior", args: [range] });
				return behaviorDash(behaviorModels);
			},
			async models(range) {
				calls.push({ method: "models", args: [range] });
				return { byModel: models, modelSeries: [], modelPerformanceSeries: [] };
			},
			async tools(range) {
				calls.push({ method: "tools", args: [range] });
				return toolsDash(tools, toolModels);
			},
			async gain(range, project) {
				calls.push({ method: "gain", args: [range, project] });
				return gain;
			},
		};

		const ctx = {
			cwd: "/Users/test/project",
			stats,
		} as HostExtensionContext;

		const snap = await fetchObservabilitySnapshot(ctx, {
			provider: "openai",
			id: "gpt",
		});
		expect(snap.status).toBe("ok");
		expect(calls.map((c) => c.method)).toEqual([
			"sync",
			"behavior",
			"behavior",
			"models",
			"tools",
			"gain",
		]);
		expect(
			calls.find(
				(c) =>
					c.method === "behavior" &&
					c.args[0] === OBSERVABILITY_RANGES.behavior30d,
			),
		).toBeDefined();
		expect(
			calls.find(
				(c) =>
					c.method === "behavior" &&
					c.args[0] === OBSERVABILITY_RANGES.behaviorAll,
			),
		).toBeDefined();
		expect(
			calls.find(
				(c) =>
					c.method === "models" && c.args[0] === OBSERVABILITY_RANGES.modelsAll,
			),
		).toBeDefined();
		expect(
			calls.find(
				(c) =>
					c.method === "tools" && c.args[0] === OBSERVABILITY_RANGES.tools30d,
			),
		).toBeDefined();
		expect(
			calls.find(
				(c) =>
					c.method === "gain" &&
					c.args[0] === "30d" &&
					c.args[1] === "/Users/test/project",
			),
		).toBeDefined();
		expect(snap.modelsAll![0]!.totalTokens).toBe(2000);
		expect(snap.gainOverall!.hits).toBe(3);
	});

	test("missing facade returns unavailable without local recomputation", async () => {
		const ctx = { cwd: "/tmp" } as HostExtensionContext;
		const snap = await fetchObservabilitySnapshot(ctx);
		expect(snap.status).toBe("unavailable");
		expect(snap.error).toBe(HOST_STATS_REQUIRED_ERROR);
		expect(snap.behavior30d).toBeUndefined();
		expect(snap.modelsAll).toBeUndefined();
		expect(snap.tools30d).toBeUndefined();
		expect(snap.gainOverall).toBeUndefined();
	});

	test("rejected aggregate returns unavailable without matrices", async () => {
		const stats: ExtensionStats = {
			async sync() {
				return { processed: 0, files: 0 };
			},
			async behavior() {
				throw new Error("boom");
			},
			async models() {
				return { byModel: [], modelSeries: [], modelPerformanceSeries: [] };
			},
			async tools() {
				return toolsDash([], []);
			},
			async gain() {
				return gainDash();
			},
		};
		const ctx = { cwd: "/tmp", stats } as HostExtensionContext;
		const snap = await fetchObservabilitySnapshot(ctx);
		expect(snap.status).toBe("unavailable");
		expect(snap.error).toContain("boom");
		expect(snap.behaviorModels30d).toBeUndefined();
	});
});
