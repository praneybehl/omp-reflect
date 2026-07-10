import type {
	BehaviorDashboardStats,
	BehaviorModelStats,
	BehaviorOverallStats,
	GainSourceTotals,
	ToolModelStats,
	ToolUsageStats,
} from "@oh-my-pi/omp-stats/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { OwnModelAggregate, OwnToolAggregate } from "./analytics/types.ts";
import {
	HOST_STATS_REQUIRED_ERROR,
	type HostExtensionContext,
	type HostModelStats,
	tryHostStats,
} from "./host-stats.ts";

export type ObservabilityStatus = "ok" | "unavailable";
export type ObservabilitySource = "host" | "standalone" | "unavailable";

export interface ActiveModelRef {
	provider: string;
	id: string;
}

/**
 * Extension-owned aggregates used when the published host has no `ctx.stats`
 * facade. The functions stay lazy so host-backed runs never open our DB.
 */
export interface StandaloneObservabilityDeps {
	syncOwn(): Promise<{ processed: number; files: number }>;
	ownModels(limit: number): Promise<OwnModelAggregate[]>;
	ownTools(limit: number): Promise<OwnToolAggregate[]>;
}

export interface ReflectionObservabilitySnapshot {
	status: ObservabilityStatus;
	/** Which aggregate implementation produced this snapshot. */
	source: ObservabilitySource;
	/** Normalized failure when status is unavailable. */
	error?: string;
	behavior30d?: BehaviorOverallStats;
	behaviorAll?: BehaviorOverallStats;
	behaviorModels30d?: BehaviorModelStats[];
	behaviorModelsAll?: BehaviorModelStats[];
	modelsAll?: HostModelStats[];
	tools30d?: ToolUsageStats[];
	toolModels30d?: ToolModelStats[];
	gainOverall?: GainSourceTotals;
}

const BEHAVIOR_MODEL_LIMIT = 8;
const MODEL_LIMIT = 8;
const TOOL_LIMIT = 12;
const TOOL_MODEL_LIMIT = 12;

/** Exact ranges observability requests from the host facade. */
export const OBSERVABILITY_RANGES = {
	behavior30d: "30d",
	behaviorAll: "all",
	modelsAll: "all",
	tools30d: "30d",
	gain30d: "30d",
} as const;

function normalizeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Sort by `score` descending, keep top `limit`, and reserve one slot for the
 * active model when present so it is never dropped by the bound.
 */
export function boundWithActiveReservation<T>(
	rows: readonly T[],
	score: (row: T) => number,
	isActive: (row: T) => boolean,
	limit: number,
): T[] {
	if (rows.length === 0 || limit <= 0) return [];
	const sorted = [...rows].sort((a, b) => score(b) - score(a));
	const active = sorted.find(isActive);
	if (!active || limit === 1) return sorted.slice(0, limit);
	const top = sorted.filter((row) => row !== active).slice(0, limit - 1);
	// Keep active at its natural rank when already inside the window.
	const natural = sorted.slice(0, limit);
	if (natural.includes(active)) return natural;
	return [...top, active];
}

function asHostModelStats(
	rows: readonly { model: string; provider: string; totalRequests: number }[],
): HostModelStats[] {
	return rows.map((row) => {
		const base = row as HostModelStats;
		return {
			...base,
			totalTokens: typeof base.totalTokens === "number" ? base.totalTokens : 0,
		};
	});
}

function asStandaloneModelStats(
	rows: readonly OwnModelAggregate[],
): HostModelStats[] {
	return rows.map((row) => ({
		model: row.model,
		provider: row.provider,
		totalRequests: row.totalRequests,
		successfulRequests: Math.max(0, row.totalRequests - row.failedRequests),
		failedRequests: row.failedRequests,
		errorRate:
			row.totalRequests === 0 ? 0 : row.failedRequests / row.totalRequests,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		cacheRate: 0,
		totalCost: row.totalCost,
		totalPremiumRequests: 0,
		avgDuration: 0,
		avgTtft: 0,
		avgTokensPerSecond: 0,
		firstTimestamp: row.lastTimestamp,
		lastTimestamp: row.lastTimestamp,
		totalTokens: row.totalTokens,
	}));
}

function asStandaloneToolStats(
	rows: readonly OwnToolAggregate[],
): ToolUsageStats[] {
	return rows.map((row) => ({
		tool: row.tool,
		calls: row.calls,
		errors: row.errors,
		argsChars: 0,
		resultChars: 0,
		totalTokensShare: 0,
		outputTokensShare: 0,
		costShare: 0,
		lastUsed: row.lastUsed,
	}));
}

function activeMatcher(
	active: ActiveModelRef | undefined,
): (provider: string, model: string) => boolean {
	if (!active) return () => false;
	return (provider, model) =>
		provider === active.provider && model === active.id;
}

/**
 * Fetch and bound observability aggregates for a reflection audit. A host
 * facade always wins; otherwise the injected extension-owned pipeline supplies
 * models and tools without ever opening the host's stats database.
 */
export async function fetchObservabilitySnapshot(
	ctx: HostExtensionContext,
	activeModel?: ActiveModelRef,
	standalone?: StandaloneObservabilityDeps,
): Promise<ReflectionObservabilitySnapshot> {
	const facade = tryHostStats(ctx);
	if (!facade) {
		if (!standalone) {
			logger.warn("reflect observability unavailable", {
				reason: HOST_STATS_REQUIRED_ERROR,
			});
			return {
				status: "unavailable",
				source: "unavailable",
				error: HOST_STATS_REQUIRED_ERROR,
			};
		}

		try {
			await standalone.syncOwn();
			const [ownModels, ownTools] = await Promise.all([
				standalone.ownModels(MODEL_LIMIT),
				standalone.ownTools(TOOL_LIMIT),
			]);
			return {
				status: "ok",
				source: "standalone",
				modelsAll: asStandaloneModelStats(ownModels)
					.sort((a, b) => b.totalRequests - a.totalRequests)
					.slice(0, MODEL_LIMIT),
				tools30d: asStandaloneToolStats(ownTools)
					.sort((a, b) => b.calls - a.calls)
					.slice(0, TOOL_LIMIT),
			};
		} catch (err) {
			const message = normalizeError(err);
			logger.warn("reflect observability fetch failed", { err: message });
			return {
				status: "unavailable",
				source: "unavailable",
				error: message,
			};
		}
	}

	try {
		await facade.sync();
		const [behavior30d, behaviorAll, modelsAll, tools30d, gain] =
			await Promise.all([
				facade.behavior("30d"),
				facade.behavior("all"),
				facade.models("all"),
				facade.tools("30d"),
				facade.gain("30d", ctx.cwd),
			]);

		const isActive = activeMatcher(activeModel);
		const hostModels = asHostModelStats(modelsAll.byModel);
		const toolModelSource = activeModel
			? tools30d.byToolModel.filter((row) => isActive(row.provider, row.model))
			: tools30d.byToolModel;

		return {
			status: "ok",
			source: "host",
			behavior30d: behavior30d.overall,
			behaviorAll: behaviorAll.overall,
			behaviorModels30d: boundWithActiveReservation(
				behavior30d.byModel,
				(row) => row.totalMessages,
				(row) => isActive(row.provider, row.model),
				BEHAVIOR_MODEL_LIMIT,
			),
			behaviorModelsAll: boundWithActiveReservation(
				behaviorAll.byModel,
				(row) => row.totalMessages,
				(row) => isActive(row.provider, row.model),
				BEHAVIOR_MODEL_LIMIT,
			),
			modelsAll: boundWithActiveReservation(
				hostModels,
				(row) => row.totalRequests,
				(row) => isActive(row.provider, row.model),
				MODEL_LIMIT,
			),
			tools30d: [...tools30d.byTool]
				.sort((a, b) => b.calls - a.calls)
				.slice(0, TOOL_LIMIT),
			toolModels30d: [...toolModelSource]
				.sort((a, b) => b.calls - a.calls)
				.slice(0, TOOL_MODEL_LIMIT),
			gainOverall: gain.overall,
		};
	} catch (err) {
		const message = normalizeError(err);
		logger.warn("reflect observability fetch failed", { err: message });
		return { status: "unavailable", source: "unavailable", error: message };
	}
}

/** Test seam: build a snapshot from already-fetched aggregates. */
export function buildObservabilitySnapshotFromAggregates(input: {
	behavior30d: BehaviorDashboardStats;
	behaviorAll: BehaviorDashboardStats;
	modelsAll: { byModel: HostModelStats[] };
	tools30d: { byTool: ToolUsageStats[]; byToolModel: ToolModelStats[] };
	gainOverall: GainSourceTotals;
	activeModel?: ActiveModelRef;
}): ReflectionObservabilitySnapshot {
	const isActive = activeMatcher(input.activeModel);
	const toolModelSource = input.activeModel
		? input.tools30d.byToolModel.filter((row) =>
				isActive(row.provider, row.model),
			)
		: input.tools30d.byToolModel;
	return {
		status: "ok",
		source: "host",
		behavior30d: input.behavior30d.overall,
		behaviorAll: input.behaviorAll.overall,
		behaviorModels30d: boundWithActiveReservation(
			input.behavior30d.byModel,
			(row) => row.totalMessages,
			(row) => isActive(row.provider, row.model),
			BEHAVIOR_MODEL_LIMIT,
		),
		behaviorModelsAll: boundWithActiveReservation(
			input.behaviorAll.byModel,
			(row) => row.totalMessages,
			(row) => isActive(row.provider, row.model),
			BEHAVIOR_MODEL_LIMIT,
		),
		modelsAll: boundWithActiveReservation(
			input.modelsAll.byModel,
			(row) => row.totalRequests,
			(row) => isActive(row.provider, row.model),
			MODEL_LIMIT,
		),
		tools30d: [...input.tools30d.byTool]
			.sort((a, b) => b.calls - a.calls)
			.slice(0, TOOL_LIMIT),
		toolModels30d: [...toolModelSource]
			.sort((a, b) => b.calls - a.calls)
			.slice(0, TOOL_MODEL_LIMIT),
		gainOverall: input.gainOverall,
	};
}
