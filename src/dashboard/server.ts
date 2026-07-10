import { buildActivityStats } from "../analytics/activity.ts";
import type { ActivityDb } from "../analytics/db.ts";
import type { ActivityStats } from "../analytics/types.ts";
import appHtmlAsset from "./app.html" with { type: "text" };

// @types/bun ambiently types `*.html` imports as HTMLBundle (its dev-server
// route feature); with `{ type: "text" }` the runtime actually provides the
// file contents as a string, so the ambient library type is wrong here.
const appHtml = appHtmlAsset as unknown as string;

export interface ActivitySyncResult {
	processed: number;
	files: number;
}

/** Production dashboard dependencies: extension-owned DB plus its incremental sync. */
export interface ActivityDashboardDeps {
	db: ActivityDb;
	sync: () => Promise<ActivitySyncResult>;
}

/**
 * Narrow reader seam for HTTP tests. Production callers use `ActivityDashboardDeps`,
 * which reads from `buildActivityStats(db)` on every GET without a cache.
 */
export interface ActivityDashboardFixtureDeps {
	getStats: () => ActivityStats | Promise<ActivityStats>;
	sync: () => Promise<ActivitySyncResult>;
}

export interface ActivityDashboardHandle {
	port: number;
	url: string;
	stop(): void;
}

type ActivityDashboardServerDeps =
	| ActivityDashboardDeps
	| ActivityDashboardFixtureDeps;

function isFixtureDeps(
	deps: ActivityDashboardServerDeps,
): deps is ActivityDashboardFixtureDeps {
	return "getStats" in deps;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function text(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

export function startActivityDashboard(
	deps: ActivityDashboardDeps,
	port?: number,
): Promise<ActivityDashboardHandle>;
export function startActivityDashboard(
	deps: ActivityDashboardFixtureDeps,
	port?: number,
): Promise<ActivityDashboardHandle>;
/** Start the local Activity HTTP server on an ephemeral port by default. */
export async function startActivityDashboard(
	deps: ActivityDashboardServerDeps,
	port = 0,
): Promise<ActivityDashboardHandle> {
	const getStats = isFixtureDeps(deps)
		? deps.getStats
		: (): ActivityStats => buildActivityStats(deps.db);
	const server = Bun.serve({
		port,
		async fetch(request): Promise<Response> {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/") {
				return text(appHtml);
			}
			if (request.method === "GET" && url.pathname === "/api/activity") {
				try {
					return json(await getStats());
				} catch {
					return json({ error: "Unable to read activity." }, 500);
				}
			}
			if (request.method === "POST" && url.pathname === "/api/sync") {
				try {
					return json(await deps.sync());
				} catch {
					return json({ error: "Unable to sync activity." }, 500);
				}
			}
			return new Response("Not Found", { status: 404 });
		},
	});

	return {
		port: server.port ?? port,
		url: `http://127.0.0.1:${server.port ?? port}`,
		stop(): void {
			server.stop(true);
		},
	};
}
