/**
 * Self-contained activity analytics — public contracts.
 *
 * The extension runs its OWN incremental parser over the host's session JSONL
 * into its OWN database (`omp-reflect-activity.sqlite` beside the schedule
 * DB). It never opens or writes the host's `stats.db`; the two accounting
 * systems are fully independent so the extension works on a stock published
 * omp with no `ctx.stats` facade and no core PR.
 *
 * The payload shapes intentionally mirror the Activity dashboard contract
 * from the oh-my-pi `feat/activity-insights` branch so the dashboard UI and
 * calendar math port 1:1.
 */

/** One local calendar day inside the displayed 52-week activity window. */
export interface ActivityDayPoint {
	/** Local ISO day key (`YYYY-MM-DD`), server timezone. */
	date: string;
	/** Sum of stored provider `usage.totalTokens` recorded on this local day. */
	tokens: number;
	/** Assistant requests recorded on this local day. */
	requests: number;
	/** Completed top-level user tasks on this local day. */
	tasks: number;
}

/** Week totals over the displayed calendar window (Sunday-keyed). */
export interface ActivityWeekPoint {
	weekStart: string;
	tokens: number;
	requests: number;
	tasks: number;
}

/** Running lifetime token total at each displayed week. */
export interface ActivityCumulativePoint {
	weekStart: string;
	totalTokens: number;
}

/** One canonical skill in the most-used ranking. */
export interface ActivitySkillUsage {
	skill: string;
	uses: number;
	/** uses / total qualifying activations (0 when none). */
	share: number;
	/** Unix ms of the most recent activation. */
	lastUsed: number;
}

/** One provider/model in the most-used ranking. */
export interface ActivityModelUsage {
	model: string;
	provider: string;
	requests: number;
	/** requests / all assistant requests (0 when none). */
	share: number;
	totalTokens: number;
}

/** One effective thinking level in the reasoning breakdown. */
export interface ActivityReasoningLevel {
	level: string;
	requests: number;
	/** requests / requests with a known thinking level. */
	share: number;
}

/** One accepted reflection finding rendered in the dashboard feed. */
export interface ActivityReflectionFeedItem {
	attemptId: string;
	category: string;
	observation: string;
	evidence: string;
	suggestion: string;
	expectedImpact: string;
	confidence: string;
	project: string;
	model: string;
	provider: string;
	finishedAt: number;
}

/** Complete Activity dashboard payload (`GET /api/activity`). */
export interface ActivityStats {
	lifetimeTokens: number;
	totalRequests: number;
	peakDay: { date: string; tokens: number } | null;
	streak: { current: number; longest: number };
	longestTask: { durationMs: number; date: string; folder: string } | null;
	totalTasks: number;
	priority: {
		priorityRequests: number;
		totalRequests: number;
		percentage: number | null;
	};
	reasoning: {
		levels: ActivityReasoningLevel[];
		knownRequests: number;
		totalRequests: number;
	};
	skills: {
		distinctSkills: number;
		totalUses: number;
		topSkills: ActivitySkillUsage[];
	};
	models: ActivityModelUsage[];
	/** Exactly 52 local calendar weeks of days, zero days materialized. */
	daily: ActivityDayPoint[];
	weekly: ActivityWeekPoint[];
	cumulative: ActivityCumulativePoint[];
	window: { start: string; end: string; timezone: string };
	reflections: ActivityReflectionFeedItem[];
}

/** Which agent produced a transcript, derived from its path. */
export type AgentKind = "main" | "subagent" | "advisor" | "reflection";

/**
 * Bounded per-model aggregate fed to reflection prompts when no host
 * `ctx.stats` facade exists (standalone mode). Field names align with the
 * host's `ModelStats` so prompt payloads stay comparable across modes.
 */
export interface OwnModelAggregate {
	model: string;
	provider: string;
	totalRequests: number;
	failedRequests: number;
	totalTokens: number;
	totalCost: number;
	/** Unix ms of the most recent request. */
	lastTimestamp: number;
}

/** Bounded per-tool aggregate for reflection prompts in standalone mode. */
export interface OwnToolAggregate {
	tool: string;
	calls: number;
	errors: number;
	/** Unix ms of the most recent call. */
	lastUsed: number;
}
