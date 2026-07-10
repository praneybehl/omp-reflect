import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import type { HostExtensionContext } from "./host-stats.ts";
import { ReflectRecorder, type SessionLocator } from "./recorder.ts";
import { runReflection } from "./runner.ts";
import {
	HEARTBEAT_MS,
	type LeaseHandle,
	openReflectSchedule,
	type ReflectSchedule,
} from "./schedule.ts";
import { extractTaskWindows } from "./snapshot.ts";
import { findingsToSelectOptions, NO_REFLECTIONS_YET } from "./ui/findings.ts";

const FLAG_REFLECT_DAILY = "reflect-daily";
const STATUS_KEY = "reflect";

/** Process-local override from `--reflect-daily` (does not rewrite the persisted switch). */
let processAutoEnabled = false;

interface OwnedRun {
	controller: AbortController;
	lease: LeaseHandle;
	sourceSessionId: string;
}

/**
 * Determine top-level interactive main session by the sessions-root relative-depth
 * rule: `<= 2` path segments under getSessionsDir() means main agent.
 */
export function isTopLevelMainSession(
	sessionFile: string | undefined,
): boolean {
	if (!sessionFile) return false;
	const rel = path.relative(getSessionsDir(), sessionFile);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
	const segments = rel.split(path.sep).filter(Boolean);
	return segments.length <= 2;
}

function formatTs(ms: number | null): string {
	if (ms == null) return "never";
	return new Date(ms).toISOString();
}

function createListAll(pi: ExtensionAPI): () => Promise<SessionLocator[]> {
	return async () => {
		const sessions = await pi.pi.SessionManager.listAll();
		return sessions.map((s) => ({
			id: s.id,
			path: s.path,
			cwd: s.cwd,
		}));
	};
}

function createRecorder(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): ReflectRecorder {
	return new ReflectRecorder({
		sessionManager: ctx.sessionManager,
		listAll: createListAll(pi),
	});
}

async function handleShow(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const recorder = createRecorder(pi, ctx);
	const findings = await recorder.loadLatestFindings(
		ctx.sessionManager.getSessionId(),
	);
	if (findings.length === 0) {
		ctx.ui.notify(NO_REFLECTIONS_YET, "info");
		return;
	}
	const options = findingsToSelectOptions(findings);
	await ctx.ui.select("Activity Reflections", options);
}

async function handleStatus(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	schedule: ReflectSchedule,
): Promise<void> {
	const state = schedule.getState();
	const auto = processAutoEnabled || state.enabled;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
	const lease =
		state.lease_owner && state.lease_until && state.lease_until > Date.now()
			? `held until ${new Date(state.lease_until).toISOString()}`
			: "free";
	// Coverage watermark: which completed tasks in this session the insights
	// are based on, per the sidecar's successful attempts.
	let coverage = "no completed tasks yet";
	try {
		const windows = extractTaskWindows(ctx.sessionManager.getBranch());
		if (windows.length > 0) {
			const covered = await createRecorder(pi, ctx).listCoveredSourceIds(
				ctx.sessionManager.getSessionId(),
			);
			const coveredWindows = windows.filter((w) =>
				covered.has(w.sourceEntryId),
			);
			const latest = coveredWindows.at(-1);
			coverage = latest
				? `${coveredWindows.length}/${windows.length} tasks (insights through ${latest.startedAt})`
				: `0/${windows.length} tasks`;
		}
	} catch (err) {
		coverage = `unavailable (${String(err)})`;
	}
	const lines = [
		`auto: ${auto ? "on" : "off"}${processAutoEnabled && !state.enabled ? " (process flag)" : ""}`,
		`active model: ${model}`,
		`coverage: ${coverage}`,
		`last attempt: ${formatTs(state.last_attempt_at)}`,
		`last success: ${formatTs(state.last_success_at)}`,
		`next scheduled: ${formatTs(state.next_scheduled_attempt_at)}`,
		`retry floor: 1h after failure / 24h after success`,
		`lease: ${lease}`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleAuto(
	args: string,
	ctx: ExtensionCommandContext,
	schedule: ReflectSchedule,
): Promise<void> {
	const mode = args.trim().toLowerCase();
	if (mode === "on") {
		schedule.setEnabled(true);
		ctx.ui.notify("Activity Reflections auto mode enabled.", "info");
		return;
	}
	if (mode === "off") {
		schedule.setEnabled(false);
		ctx.ui.notify("Activity Reflections auto mode disabled.", "info");
		return;
	}
	ctx.ui.notify("Usage: /reflect auto on|off", "warning");
}

async function handleRun(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	schedule: ReflectSchedule,
	owned: { current: OwnedRun | undefined },
): Promise<void> {
	await ctx.waitForIdle();
	const lease = schedule.tryClaimLease();
	if (!lease) {
		ctx.ui.notify(
			"Activity Reflections is already running in another process.",
			"warning",
		);
		return;
	}

	const controller = new AbortController();
	const sourceSessionId = ctx.sessionManager.getSessionId();
	owned.current = { controller, lease, sourceSessionId };

	const heartbeat = setInterval(() => {
		if (!lease.renew()) {
			controller.abort();
		}
	}, HEARTBEAT_MS);

	ctx.ui.setStatus(STATUS_KEY, "reflect…");
	try {
		const recorder = createRecorder(pi, ctx);
		const result = await runReflection({
			ctx: ctx as HostExtensionContext,
			recorder,
			mode: "manual",
			signal: controller.signal,
			notifyUnavailable: (message) => {
				ctx.ui.notify(`Observability unavailable: ${message}`, "warning");
			},
		});

		if (result.status === "not_dispatched") {
			// "No uncovered tasks" is the caught-up steady state of an ongoing
			// process, not a failure: report it and leave cadence state alone.
			if (result.errorCategory === "no_tasks") {
				ctx.ui.notify(
					"Nothing new to reflect on — all completed tasks in this session are covered.",
					"info",
				);
				return;
			}
			ctx.ui.notify(
				`Reflection not dispatched (${result.errorCategory ?? "unknown"}).`,
				"warning",
			);
			schedule.commitAttempt(lease.owner, { success: false });
			return;
		}

		const success = result.status === "success";
		schedule.commitAttempt(lease.owner, { success });
		const modelLabel = result.model
			? `${result.model.provider}/${result.model.id}`
			: "unknown";
		if (success) {
			ctx.ui.notify(
				`Reflection accepted ${result.findings.length} finding(s) via ${modelLabel}.`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`Reflection finished with status ${result.status}${result.errorCategory ? ` (${result.errorCategory})` : ""}.`,
				"warning",
			);
		}
	} finally {
		clearInterval(heartbeat);
		lease.release();
		if (owned.current?.lease.owner === lease.owner) owned.current = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function startDetachedAuto(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	schedule: ReflectSchedule,
	owned: { current: OwnedRun | undefined },
	snapshot: {
		sourceSessionId: string;
		sessionFile: string;
		cwd: string;
		modelProvider: string;
		modelId: string;
	},
): void {
	if (owned.current) return;
	const state = schedule.getState();
	const autoOn = processAutoEnabled || state.enabled;
	if (!autoOn) return;
	if (!schedule.canSchedule()) return;

	const lease = schedule.tryClaimLease();
	if (!lease) return;

	const controller = new AbortController();
	owned.current = {
		controller,
		lease,
		sourceSessionId: snapshot.sourceSessionId,
	};

	const heartbeat = setInterval(() => {
		if (!lease.renew()) controller.abort();
	}, HEARTBEAT_MS);

	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "reflect…");

	void (async () => {
		try {
			// Capture identity is immutable; still use live ctx for host APIs.
			const recorder = createRecorder(pi, ctx);
			const result = await runReflection({
				ctx: ctx as HostExtensionContext,
				recorder,
				mode: "scheduled",
				signal: controller.signal,
			});
			const success = result.status === "success";
			// Late completions cannot commit a lost lease.
			if (lease.isHeld()) {
				if (result.status !== "not_dispatched") {
					schedule.commitAttempt(lease.owner, { success });
				}
			}
			logger.debug("reflect auto finished", {
				status: result.status,
				findings: result.findings.length,
				sessionId: snapshot.sourceSessionId,
			});
		} catch (err) {
			logger.warn("reflect auto failed", { err: String(err) });
			if (lease.isHeld())
				schedule.commitAttempt(lease.owner, { success: false });
		} finally {
			clearInterval(heartbeat);
			lease.release();
			if (owned.current?.lease.owner === lease.owner) owned.current = undefined;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	})();
}

async function abortOwned(
	owned: { current: OwnedRun | undefined },
	recorderFactory: () => ReflectRecorder,
): Promise<void> {
	const current = owned.current;
	if (!current) return;
	current.controller.abort();
	// Best-effort aborted finish is handled by the runner when the signal fires;
	// if the runner never dispatched, ensure we still release the lease.
	try {
		await recorderFactory().flush();
	} catch {
		// ignore
	}
	current.lease.release();
	owned.current = undefined;
}

export default function (pi: ExtensionAPI): void {
	pi.setLabel("Activity Reflections");

	const schedule = openReflectSchedule();
	const owned: { current: OwnedRun | undefined } = { current: undefined };

	pi.registerFlag(FLAG_REFLECT_DAILY, {
		description: "Enable Activity Reflections auto mode for this process only",
		type: "boolean",
		default: false,
	});

	// Apply process flag after flags are populated (session_start is earliest safe hook).
	pi.on("session_start", () => {
		if (pi.getFlag(FLAG_REFLECT_DAILY) === true) {
			processAutoEnabled = true;
		}
	});

	pi.registerCommand("reflect", {
		description: "Activity Reflections: run | show | status | auto on|off",
		getArgumentCompletions(argumentPrefix: string) {
			const prefix = argumentPrefix.trim().toLowerCase();
			const items = [
				{
					value: "run",
					label: "run",
					description: "Audit up to six recent completed tasks",
				},
				{
					value: "show",
					label: "show",
					description: "Show latest accepted findings",
				},
				{
					value: "status",
					label: "status",
					description: "Show auto state, model, lease",
				},
				{
					value: "auto on",
					label: "auto on",
					description: "Enable automatic reflections",
				},
				{
					value: "auto off",
					label: "auto off",
					description: "Disable automatic reflections",
				},
			];
			if (!prefix) return items;
			return items.filter(
				(item) =>
					item.value.startsWith(prefix) || item.label.startsWith(prefix),
			);
		},
		async handler(args, ctx) {
			const trimmed = args.trim();
			const [head, ...rest] = trimmed.split(/\s+/);
			const command = (head ?? "").toLowerCase();
			const restArgs = rest.join(" ");

			if (!command || command === "show") {
				await handleShow(ctx, pi);
				return;
			}
			if (command === "run") {
				await handleRun(ctx, pi, schedule, owned);
				return;
			}
			if (command === "status") {
				await handleStatus(ctx, pi, schedule);
				return;
			}
			if (command === "auto") {
				await handleAuto(restArgs, ctx, schedule);
				return;
			}
			ctx.ui.notify("Usage: /reflect [run|show|status|auto on|off]", "warning");
		},
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return; // interactive-only auto
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!isTopLevelMainSession(sessionFile)) return;
		const model = ctx.model;
		if (!model) return;
		startDetachedAuto(ctx, pi, schedule, owned, {
			sourceSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: sessionFile!,
			cwd: ctx.cwd,
			modelProvider: model.provider,
			modelId: model.id,
		});
	});

	pi.on("session_before_switch", async () => {
		await abortOwned(
			owned,
			() =>
				new ReflectRecorder({
					sessionManager: {
						getSessionId: () => owned.current?.sourceSessionId ?? "",
						getSessionFile: () => undefined,
						getCwd: () => "",
					},
					listAll: createListAll(pi),
				}),
		);
	});

	pi.on("session_shutdown", async () => {
		await abortOwned(
			owned,
			() =>
				new ReflectRecorder({
					sessionManager: {
						getSessionId: () => owned.current?.sourceSessionId ?? "",
						getSessionFile: () => undefined,
						getCwd: () => "",
					},
					listAll: createListAll(pi),
				}),
		);
		schedule.close();
	});
}
