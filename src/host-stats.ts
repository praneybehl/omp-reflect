/**
 * Structural host-stats facade.
 *
 * The published 16.3.15 `ExtensionContext` does not include `ctx.stats`. Main
 * oh-my-pi adds the facade; this module mirrors its shape so the extension
 * type-checks against the published package while requiring a host that
 * actually supplies the methods at runtime.
 *
 * No value-imports of @oh-my-pi/omp-stats aggregator/db/gain modules.
 */
import type {
	BehaviorDashboardStats,
	DashboardStats,
	GainDashboardStats,
	ModelStats,
	ToolDashboardStats,
} from "@oh-my-pi/omp-stats/types";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Additive main-branch field not yet on the published ModelStats. */
export type HostModelStats = ModelStats & { totalTokens: number };

export type ExtensionStatsRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

/**
 * Exact five-method facade Main attaches to ExtensionContext.
 * Import return types are structural mirrors of @oh-my-pi/omp-stats/types.
 */
export interface ExtensionStats {
	sync(): Promise<{ processed: number; files: number }>;
	behavior(range?: ExtensionStatsRange | null): Promise<BehaviorDashboardStats>;
	models(
		range?: ExtensionStatsRange | null,
	): Promise<
		Pick<DashboardStats, "byModel" | "modelSeries" | "modelPerformanceSeries">
	>;
	tools(range?: ExtensionStatsRange | null): Promise<ToolDashboardStats>;
	gain(
		range?: ExtensionStatsRange | null,
		project?: string | null,
	): Promise<GainDashboardStats>;
}

/** Published ExtensionContext intersected with the optional host facade. */
export type HostExtensionContext = ExtensionContext & {
	stats?: ExtensionStats;
};

export const HOST_STATS_REQUIRED_ERROR =
	"Activity Reflections requires an oh-my-pi build with ctx.stats.";

function isExtensionStats(value: unknown): value is ExtensionStats {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.sync === "function" &&
		typeof candidate.behavior === "function" &&
		typeof candidate.models === "function" &&
		typeof candidate.tools === "function" &&
		typeof candidate.gain === "function"
	);
}

/**
 * Return the host facade or throw the exact compatibility error.
 */
export function requireHostStats(ctx: HostExtensionContext): ExtensionStats {
	if (!isExtensionStats(ctx.stats)) {
		throw new Error(HOST_STATS_REQUIRED_ERROR);
	}
	return ctx.stats;
}

/**
 * Soft probe used by observability: returns the facade or undefined.
 */
export function tryHostStats(
	ctx: HostExtensionContext,
): ExtensionStats | undefined {
	return isExtensionStats(ctx.stats) ? ctx.stats : undefined;
}
