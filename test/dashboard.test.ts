import { afterEach, describe, expect, test } from "bun:test";
import type { ActivityStats } from "../src/analytics/types.ts";
import {
	type ActivityDashboardFixtureDeps,
	type ActivityDashboardHandle,
	startActivityDashboard,
} from "../src/dashboard/server.ts";

const handles: ActivityDashboardHandle[] = [];

afterEach(() => {
	for (const handle of handles.splice(0)) handle.stop();
});

const fixtureStats: ActivityStats = {
	lifetimeTokens: 12_345,
	totalRequests: 42,
	peakDay: { date: "2026-07-08", tokens: 3_000 },
	streak: { current: 3, longest: 5 },
	longestTask: {
		durationMs: 95_000,
		date: "2026-07-08",
		folder: "/work/omp-reflect",
	},
	totalTasks: 8,
	priority: { priorityRequests: 6, totalRequests: 42, percentage: 6 / 42 },
	reasoning: {
		levels: [{ level: "high", requests: 20, share: 1 }],
		knownRequests: 20,
		totalRequests: 42,
	},
	skills: {
		distinctSkills: 1,
		totalUses: 3,
		topSkills: [
			{ skill: "react-doctor", uses: 3, share: 1, lastUsed: 1_783_500_000_000 },
		],
	},
	models: [
		{
			model: "gpt-5",
			provider: "openai",
			requests: 42,
			share: 1,
			totalTokens: 12_345,
		},
	],
	daily: [{ date: "2026-07-08", tokens: 3_000, requests: 8, tasks: 2 }],
	weekly: [{ weekStart: "2026-07-05", tokens: 3_000, requests: 8, tasks: 2 }],
	cumulative: [{ weekStart: "2026-07-05", totalTokens: 12_345 }],
	window: {
		start: "2025-07-13",
		end: "2026-07-10",
		timezone: "America/Los_Angeles",
	},
	reflections: [
		{
			attemptId: "attempt-1",
			category: "workflow",
			observation: "The task windows were focused.",
			evidence: "Eight completed tasks.",
			suggestion: "Keep the focused cadence.",
			expectedImpact: "Less context switching.",
			confidence: "high",
			project: "/work/omp-reflect",
			model: "gpt-5",
			provider: "openai",
			finishedAt: 1_783_500_000_000,
		},
	],
};

function fixtureDeps(): {
	deps: ActivityDashboardFixtureDeps;
	syncCalls: () => number;
} {
	let calls = 0;
	return {
		deps: {
			getStats: () => fixtureStats,
			async sync() {
				calls += 1;
				return { processed: 7, files: 2 };
			},
		},
		syncCalls: () => calls,
	};
}

async function startFixture(
	port?: number,
): Promise<{ handle: ActivityDashboardHandle; syncCalls: () => number }> {
	const { deps, syncCalls } = fixtureDeps();
	const handle = await startActivityDashboard(deps, port);
	handles.push(handle);
	return { handle, syncCalls };
}

describe("Activity dashboard server", () => {
	test("serves the vanilla app and Activity API routes", async () => {
		const { handle, syncCalls } = await startFixture();

		const appResponse = await fetch(`${handle.url}/`);
		expect(appResponse.status).toBe(200);
		expect(appResponse.headers.get("content-type")).toContain("text/html");
		const app = await appResponse.text();
		expect(app).toContain("omp-reflect");
		expect(app).toContain("Token Activity");
		// This is the actual served app artifact, not a source implementation assertion.
		expect(app).toMatch(/data-tip-head/);
		expect(app).toMatch(/role: "img"/);
		expect(app).toMatch(/hm-grid/);

		const activityResponse = await fetch(`${handle.url}/api/activity`);
		expect(activityResponse.status).toBe(200);
		expect(activityResponse.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await activityResponse.json()).toEqual(fixtureStats);

		const syncResponse = await fetch(`${handle.url}/api/sync`, {
			method: "POST",
		});
		expect(syncResponse.status).toBe(200);
		expect(await syncResponse.json()).toEqual({ processed: 7, files: 2 });
		expect(syncCalls()).toBe(1);

		const missingResponse = await fetch(`${handle.url}/not-a-route`);
		expect(missingResponse.status).toBe(404);
	});

	test("releases a stopped port for a replacement dashboard", async () => {
		const { handle } = await startFixture();
		const port = handle.port;
		handle.stop();
		handles.splice(handles.indexOf(handle), 1);

		const replacement = await startFixture(port);
		expect(replacement.handle.port).toBe(port);
		const response = await fetch(`${replacement.handle.url}/api/activity`);
		expect(await response.json()).toEqual(fixtureStats);
	});
});
