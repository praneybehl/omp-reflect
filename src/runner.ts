import type { AssistantMessage, Model, Tool, Usage } from "@oh-my-pi/pi-ai";
import { completeSimple, type as t, validateToolCall } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { HostExtensionContext } from "./host-stats.ts";
import { fetchObservabilitySnapshot } from "./observability.ts";
import systemPromptTemplate from "./prompts/reflection-system.md" with {
	type: "text",
};
import userPromptTemplate from "./prompts/reflection-user.md" with {
	type: "text",
};
import type { ReflectRecorder } from "./recorder.ts";
import { createReflectionSanitizer } from "./sanitizer.ts";
import {
	extractTaskWindows,
	mergeTaskSnapshot,
	selectTaskWindows,
	type TaskWindow,
} from "./snapshot.ts";
import type {
	ActivityReflectionFinding,
	ActivityReflectionModelRef,
	ActivityReflectionStatus,
	ActivityReflectionUsage,
} from "./wire.ts";

export const REFLECT_MAX_OUTPUT_TOKENS = 1_600;
export const REFLECT_DEADLINE_MS = 90_000;
export const REFLECT_MAX_FINDINGS = 3;

const CATEGORIES = new Set([
	"prompting",
	"model",
	"reasoning",
	"skills",
	"tools",
	"workflow",
]);
const CONFIDENCES = new Set(["low", "medium", "high"]);

const findingSchema = t({
	category:
		"'prompting' | 'model' | 'reasoning' | 'skills' | 'tools' | 'workflow'",
	observation: "string",
	evidence: "string",
	suggestion: "string",
	expectedImpact: "string",
	confidence: "'low' | 'medium' | 'high'",
	sourceEntryIds: "string[]",
});

const respondParameters = t({
	findings: findingSchema.array(),
});

export const respondTool: Tool<typeof respondParameters> = {
	name: "respond",
	description: "Return 0–3 activity reflection findings.",
	parameters: respondParameters,
	strict: true,
};

export type ReflectRunMode = "manual" | "scheduled";

export interface ReflectRunResult {
	status: ActivityReflectionStatus | "not_dispatched";
	attemptId: string;
	findings: ActivityReflectionFinding[];
	model?: ActivityReflectionModelRef;
	errorCategory?: string;
	usage?: ActivityReflectionUsage;
	durationMs: number;
}

export interface ReflectRunDeps {
	ctx: HostExtensionContext;
	recorder: ReflectRecorder;
	mode: ReflectRunMode;
	/** Optional abort signal (session switch / shutdown). */
	signal?: AbortSignal;
	/** Inject completeSimple for tests. */
	complete?: typeof completeSimple;
	/** When true, notify UI on observability unavailability (manual runs). */
	notifyUnavailable?: (message: string) => void;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function usageFromAssistant(
	message: AssistantMessage,
): ActivityReflectionUsage | undefined {
	const usage = message.usage as Usage | undefined;
	if (!usage) return undefined;
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		cost: {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		},
	};
}

function modelRef(model: Model): ActivityReflectionModelRef {
	return {
		provider: model.provider,
		id: model.id,
		api: String(model.api),
	};
}

/**
 * Validate and accept at most three findings. Reject unknown source ids,
 * empty fields, or invalid shape.
 */
export function acceptFindings(
	raw: unknown,
	allowedSourceIds: ReadonlySet<string>,
	sanitize: (text: string) => string,
):
	| { ok: true; findings: ActivityReflectionFinding[] }
	| { ok: false; errorCategory: string } {
	if (!raw || typeof raw !== "object") {
		return { ok: false, errorCategory: "invalid_shape" };
	}
	const findingsRaw = (raw as { findings?: unknown }).findings;
	if (!Array.isArray(findingsRaw)) {
		return { ok: false, errorCategory: "invalid_shape" };
	}

	const accepted: ActivityReflectionFinding[] = [];
	for (const item of findingsRaw) {
		if (accepted.length >= REFLECT_MAX_FINDINGS) break;
		if (!item || typeof item !== "object") {
			return { ok: false, errorCategory: "invalid_shape" };
		}
		const row = item as Record<string, unknown>;
		if (!CATEGORIES.has(String(row.category))) {
			return { ok: false, errorCategory: "invalid_category" };
		}
		if (!CONFIDENCES.has(String(row.confidence))) {
			return { ok: false, errorCategory: "invalid_confidence" };
		}
		if (
			!isNonEmptyString(row.observation) ||
			!isNonEmptyString(row.evidence) ||
			!isNonEmptyString(row.suggestion) ||
			!isNonEmptyString(row.expectedImpact)
		) {
			return { ok: false, errorCategory: "empty_fields" };
		}
		if (!Array.isArray(row.sourceEntryIds) || row.sourceEntryIds.length === 0) {
			return { ok: false, errorCategory: "missing_source_ids" };
		}
		const sourceEntryIds: string[] = [];
		for (const id of row.sourceEntryIds) {
			if (typeof id !== "string" || !allowedSourceIds.has(id)) {
				return { ok: false, errorCategory: "unknown_source_id" };
			}
			sourceEntryIds.push(id);
		}
		accepted.push({
			category: row.category as ActivityReflectionFinding["category"],
			observation: sanitize(row.observation.trim()),
			evidence: sanitize(row.evidence.trim()),
			suggestion: sanitize(row.suggestion.trim()),
			expectedImpact: sanitize(row.expectedImpact.trim()),
			confidence: row.confidence as ActivityReflectionFinding["confidence"],
			sourceEntryIds,
		});
	}
	return { ok: true, findings: accepted };
}

function extractRespondArgs(message: AssistantMessage): unknown {
	for (const block of message.content) {
		if (block.type === "toolCall" && block.name === "respond") {
			try {
				return validateToolCall([respondTool], block);
			} catch {
				return block.arguments;
			}
		}
	}
	// Fallback: try JSON in text.
	const text = message.content
		.filter((b) => b.type === "text")
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("\n")
		.trim();
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return undefined;
		try {
			return JSON.parse(match[0]!);
		} catch {
			return undefined;
		}
	}
}

/**
 * Run one reflection audit against the active model. Never falls back to another model.
 */
export async function runReflection(
	deps: ReflectRunDeps,
): Promise<ReflectRunResult> {
	const { ctx, recorder, mode, signal } = deps;
	const complete = deps.complete ?? completeSimple;
	const startedAt = Date.now();
	const attemptId = crypto.randomUUID();
	const sourceSessionId = ctx.sessionManager.getSessionId();

	const model = ctx.model;
	if (!model) {
		logger.warn("reflect not dispatched: no active model");
		return {
			status: "not_dispatched",
			attemptId,
			findings: [],
			errorCategory: "missing_model",
			durationMs: Date.now() - startedAt,
		};
	}

	const sessionId = sourceSessionId;
	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKey(model, sessionId);
	} catch (err) {
		logger.warn("reflect not dispatched: credential lookup failed", {
			err: String(err),
		});
		return {
			status: "not_dispatched",
			attemptId,
			findings: [],
			model: modelRef(model),
			errorCategory: "missing_credential",
			durationMs: Date.now() - startedAt,
		};
	}
	if (!apiKey) {
		logger.warn("reflect not dispatched: missing credential");
		return {
			status: "not_dispatched",
			attemptId,
			findings: [],
			model: modelRef(model),
			errorCategory: "missing_credential",
			durationMs: Date.now() - startedAt,
		};
	}

	const activeModel = { provider: model.provider, id: model.id };
	const observability = await fetchObservabilitySnapshot(ctx, activeModel);
	if (observability.status === "unavailable" && deps.notifyUnavailable) {
		deps.notifyUnavailable(observability.error ?? "Observability unavailable");
	}

	const branch = ctx.sessionManager.getBranch();
	const allWindows = extractTaskWindows(branch);
	const covered =
		mode === "scheduled"
			? await recorder.listCoveredSourceIds(sourceSessionId)
			: undefined;
	const selected = selectTaskWindows(allWindows, mode, covered);
	if (selected.length === 0) {
		return {
			status: "not_dispatched",
			attemptId,
			findings: [],
			model: modelRef(model),
			errorCategory: "no_tasks",
			durationMs: Date.now() - startedAt,
		};
	}

	const snapshot = mergeTaskSnapshot(selected, observability);
	const sourceEntryIds = snapshot.tasks.map((t) => t.sourceEntryId);
	const allowed = new Set(sourceEntryIds);
	const modelInfo = modelRef(model);

	await recorder.writeStart({
		attemptId,
		sourceSessionId,
		sourceEntryIds,
		project: ctx.cwd,
		startedAt,
		model: modelInfo,
	});

	const sanitizer = await createReflectionSanitizer(ctx.cwd);
	const tasksForPrompt = snapshot.tasks.map(sanitizeTask(sanitizer.sanitize));
	const obsJson = sanitizer.sanitize(JSON.stringify(snapshot.observability));
	const tasksJson = sanitizer.sanitize(JSON.stringify(tasksForPrompt));

	const systemPrompt = prompt.render(systemPromptTemplate);
	const userPrompt = prompt.render(userPromptTemplate, {
		active_model: `${model.provider}/${model.id}`,
		project: ctx.cwd,
		mode,
		tasks_json: tasksJson,
		observability_json: obsJson,
	});

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), REFLECT_DEADLINE_MS);

	let status: ActivityReflectionStatus = "provider_error";
	let findings: ActivityReflectionFinding[] = [];
	let errorCategory: string | undefined = "provider_error";
	let usage: ActivityReflectionUsage | undefined;

	try {
		const resolver = ctx.modelRegistry.resolver(model, sessionId);
		const response = await complete(
			model,
			{
				systemPrompt: [systemPrompt],
				messages: [
					{ role: "user", content: userPrompt, timestamp: Date.now() },
				],
				tools: [respondTool],
			},
			{
				apiKey: resolver,
				maxTokens: REFLECT_MAX_OUTPUT_TOKENS,
				reasoning: Effort.Low,
				toolChoice: { type: "tool", name: "respond" },
				serviceTier: "default",
				signal: controller.signal,
			},
		);

		usage = usageFromAssistant(response);

		if (response.stopReason === "aborted" || controller.signal.aborted) {
			status = "aborted";
			errorCategory = "aborted";
		} else if (response.stopReason === "error") {
			status = "provider_error";
			errorCategory = "provider_error";
		} else {
			const args = extractRespondArgs(response);
			const accepted = acceptFindings(args, allowed, sanitizer.sanitize);
			if (!accepted.ok) {
				status = "invalid";
				errorCategory = accepted.errorCategory;
			} else {
				status = "success";
				findings = accepted.findings;
				errorCategory = undefined;
			}
		}
	} catch (err) {
		if (
			controller.signal.aborted ||
			(err instanceof Error && err.name === "AbortError")
		) {
			status = "aborted";
			errorCategory = "aborted";
		} else {
			status = "provider_error";
			errorCategory = "provider_error";
			logger.warn("reflect provider call failed", { err: String(err) });
		}
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}

	const finishedAt = Date.now();
	await recorder.writeFinish({
		attemptId,
		sourceSessionId,
		status,
		finishedAt,
		durationMs: finishedAt - startedAt,
		usage,
		errorCategory,
		findings: status === "success" ? findings : [],
	});

	return {
		status,
		attemptId,
		findings,
		model: modelInfo,
		errorCategory,
		usage,
		durationMs: finishedAt - startedAt,
	};
}

function sanitizeTask(
	sanitize: (text: string) => string,
): (task: TaskWindow) => TaskWindow {
	return (task) => ({
		...task,
		userPrompt: sanitize(task.userPrompt),
		assistantAnswer: sanitize(task.assistantAnswer),
		tools: task.tools.map((x) => ({ ...x })),
		skills: [...task.skills],
	});
}

// Keep ExtensionContext import for documentation / type re-exports.
export type { ExtensionContext };
