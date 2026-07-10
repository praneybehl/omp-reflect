import { describe, expect, test } from "bun:test";
import type {
	BehaviorDashboardStats,
	DashboardStats,
	GainDashboardStats,
	ToolDashboardStats,
} from "@oh-my-pi/omp-stats/types";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type ExtensionStats,
	HOST_STATS_REQUIRED_ERROR,
	type HostExtensionContext,
	type HostModelStats,
	requireHostStats,
} from "../src/host-stats.ts";

function emptyBehavior(): BehaviorDashboardStats {
	return {
		overall: {
			totalMessages: 0,
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
		byModel: [],
		behaviorSeries: [],
	};
}

function emptyTools(): ToolDashboardStats {
	return { byTool: [], byToolModel: [], series: [] };
}

function emptyGain(): GainDashboardStats {
	return {
		overall: {
			savedTokens: 0,
			savedBytes: 0,
			hits: 0,
			outputBytes: 0,
			originalBytes: 0,
			reductionPercent: null,
		},
		bySource: {
			snapcompact: {
				savedTokens: 0,
				savedBytes: 0,
				hits: 0,
				outputBytes: 0,
				originalBytes: 0,
				reductionPercent: null,
			},
		},
		timeSeries: [],
		project: null,
		projects: [],
	};
}

function emptyModels(): Pick<
	DashboardStats,
	"byModel" | "modelSeries" | "modelPerformanceSeries"
> {
	return { byModel: [], modelSeries: [], modelPerformanceSeries: [] };
}

/** Structural fixture that type-checks against @oh-my-pi/omp-stats/types. */
function matchingFacade(): ExtensionStats {
	return {
		async sync() {
			return { processed: 0, files: 0 };
		},
		async behavior() {
			return emptyBehavior();
		},
		async models() {
			return emptyModels();
		},
		async tools() {
			return emptyTools();
		},
		async gain() {
			return emptyGain();
		},
	};
}

describe("requireHostStats", () => {
	test("accepts a matching host facade", async () => {
		const stats = matchingFacade();
		const ctx = { stats } as HostExtensionContext;
		const facade = requireHostStats(ctx);
		expect(facade).toBe(stats);
		const sync = await facade.sync();
		expect(sync).toEqual({ processed: 0, files: 0 });
		const behavior = await facade.behavior("30d");
		expect(behavior.overall.totalMessages).toBe(0);
	});

	test("rejects an unmodified 16.3.15 context with the exact compatibility error", () => {
		const publishedContext = {} as ExtensionContext;
		const ctx: HostExtensionContext = publishedContext;
		expect(() => requireHostStats(ctx)).toThrow(HOST_STATS_REQUIRED_ERROR);
		expect(() => requireHostStats(ctx)).toThrow(
			"Activity Reflections requires an oh-my-pi build with ctx.stats.",
		);
	});

	test("HostModelStats structural fixture type-checks against omp-stats ModelStats", () => {
		const row: HostModelStats = {
			model: "gpt-4.1",
			provider: "openai",
			totalRequests: 10,
			successfulRequests: 9,
			failedRequests: 1,
			errorRate: 0.1,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			cacheRate: 0,
			totalCost: 0.01,
			totalPremiumRequests: 0,
			avgDuration: 100,
			avgTtft: 20,
			avgTokensPerSecond: 10,
			firstTimestamp: 1,
			lastTimestamp: 2,
			totalTokens: 150,
		};
		expect(row.totalTokens).toBe(150);
		expect(row.totalRequests).toBe(10);
	});
});
