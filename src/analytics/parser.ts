/**
 * Incremental activity-fact parser over the host's session JSONL.
 *
 * Ported (trimmed) from oh-my-pi `feat/activity-insights`
 * `packages/stats/src/parser.ts` — the post-review version: persisted
 * `custom_message` skill prompts, exact-root `skill://` reads with
 * query/fragment/selector rejection and monotonic confirmation, image-only
 * task windows, nested tool-result timestamps, and prefix-state recovery
 * across incremental offsets. Behavior lexics, cache/TTFT columns, and
 * premium accounting are intentionally not ported — activity analytics does
 * not need them.
 */
import * as path from "node:path";
import {
	coerceServiceTierByFamily,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	type ServiceTierByFamily,
} from "@oh-my-pi/pi-ai";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import {
	ACTIVITY_REFLECTION_FINISH_TYPE,
	ACTIVITY_REFLECTION_SCHEMA_VERSION,
	ACTIVITY_REFLECTION_SIDECAR,
	ACTIVITY_REFLECTION_START_TYPE,
	type ActivityReflectionAttemptFinish,
	type ActivityReflectionAttemptStart,
	type ActivityReflectionFinding,
	type ActivityReflectionStatus,
} from "../wire.ts";
import type { AgentKind } from "./types.ts";

const ADVISOR_BASENAME = "__advisor.jsonl";
const SKILL_URI_PREFIX = "skill://";

/** One assistant/reflection request row. */
export interface ActivityMessageRow {
	sessionFile: string;
	entryId: string;
	folder: string;
	model: string;
	provider: string;
	timestamp: number;
	totalTokens: number;
	costTotal: number;
	isError: boolean;
	thinkingLevel: string | null;
	priorityRealized: boolean;
	agentKind: AgentKind;
}

/** One qualifying top-level user prompt (a task window opener). */
export interface ActivityTaskRow {
	sessionFile: string;
	entryId: string;
	folder: string;
	timestamp: number;
	agentKind: AgentKind;
}

/** Monotonic completion progress for a task window. */
export interface ActivityTaskProgress {
	sessionFile: string;
	entryId: string;
	completedAt: number;
}

/** One qualifying skill activation. */
export interface ActivitySkillRow {
	sessionFile: string;
	entryId: string;
	toolCallId: string | null;
	skillName: string;
	source: "prompt" | "read";
	timestamp: number;
	confirmed: boolean;
}

/** One tool call (for reflection-prompt aggregates). */
export interface ActivityToolCallRow {
	sessionFile: string;
	entryId: string;
	toolCallId: string;
	toolName: string;
	timestamp: number;
}

/** Result link confirming/erroring a tool call. */
export interface ActivityToolResultLink {
	sessionFile: string;
	toolCallId: string;
	isError: boolean;
}

/** One folded reflection attempt from our own sidecar. */
export interface ActivityReflectionRow {
	sessionFile: string;
	folder: string;
	attemptId: string;
	sourceSessionId: string;
	project: string;
	status: ActivityReflectionStatus;
	model: string;
	provider: string;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	errorCategory: string | null;
	findings: ActivityReflectionFinding[];
}

export interface ActivityParseResult {
	messages: ActivityMessageRow[];
	tasks: ActivityTaskRow[];
	taskProgress: ActivityTaskProgress[];
	skills: ActivitySkillRow[];
	toolCalls: ActivityToolCallRow[];
	toolResults: ActivityToolResultLink[];
	reflections: ActivityReflectionRow[];
	newOffset: number;
}

/** Classify which agent produced a transcript from its path. */
export function classifyAgentKind(
	sessionPath: string,
	sessionsDir = getSessionsDir(),
): AgentKind {
	const base = path.basename(sessionPath);
	if (
		base === ADVISOR_BASENAME ||
		(base.startsWith("__advisor.") && base.endsWith(".jsonl"))
	) {
		return "advisor";
	}
	if (base === ACTIVITY_REFLECTION_SIDECAR) return "reflection";
	const rel = path.relative(sessionsDir, sessionPath);
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

/** Project folder from the munged session directory name. */
function folderFromPath(sessionPath: string, sessionsDir: string): string {
	const rel = path.relative(sessionsDir, sessionPath);
	const projectDir = rel.split(path.sep)[0] ?? "";
	return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

// ---------------------------------------------------------------------------
// Lenient JSONL scanning (byte-offset aware)
// ---------------------------------------------------------------------------

const LF = 0x0a;
const CR = 0x0d;
const decoder = new TextDecoder();

interface RawEntry {
	type?: unknown;
	id?: unknown;
	parentId?: unknown;
	timestamp?: unknown;
	customType?: unknown;
	details?: unknown;
	data?: unknown;
	message?: unknown;
	serviceTier?: unknown;
	thinkingLevel?: unknown;
	configured?: unknown;
}

function parseLine(
	bytes: Uint8Array,
	start: number,
	end: number,
): RawEntry | null {
	let stop = end;
	while (stop > start && bytes[stop - 1] === CR) stop--;
	if (stop <= start) return null;
	try {
		const value = JSON.parse(
			decoder.decode(bytes.subarray(start, stop)),
		) as unknown;
		return value && typeof value === "object" ? (value as RawEntry) : null;
	} catch {
		return null;
	}
}

function visitEntries(
	bytes: Uint8Array,
	visit: (entry: RawEntry) => void,
): number {
	let cursor = 0;
	let read = 0;
	while (cursor < bytes.length) {
		const newline = bytes.indexOf(LF, cursor);
		const hasNewline = newline !== -1;
		const lineEnd = hasNewline ? newline : bytes.length;
		const entry = parseLine(bytes, cursor, lineEnd);
		if (entry) {
			visit(entry);
			read = hasNewline ? newline + 1 : lineEnd;
		} else if (hasNewline) {
			read = newline + 1;
		} else {
			break;
		}
		cursor = hasNewline ? newline + 1 : lineEnd;
	}
	return read;
}

// ---------------------------------------------------------------------------
// Entry shape helpers
// ---------------------------------------------------------------------------

function entryId(entry: RawEntry): string | null {
	return typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(entry: RawEntry): Record<string, unknown> | null {
	return entry.type === "message" && isRecord(entry.message)
		? entry.message
		: null;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string"
		)
			out += block.text;
	}
	return out;
}

function hasImageContent(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block) => isRecord(block) && block.type === "image");
}

/** True for prompts that open a task window. */
function isTaskOpeningUser(msg: Record<string, unknown>): boolean {
	if (msg.role !== "user" || msg.synthetic === true) return false;
	if (msg.attribution !== undefined && msg.attribution !== "user") return false;
	return (
		textFromContent(msg.content).trim().length > 0 ||
		hasImageContent(msg.content)
	);
}

/**
 * Canonical skill name for an exact root `skill://<name>` read path. Nested
 * (`/`), selector (`:`), query (`?`), and fragment (`#`) forms are not root
 * activations.
 */
function rootSkillName(rawPath: unknown): string | null {
	if (typeof rawPath !== "string") return null;
	const trimmed = rawPath.trim();
	if (!trimmed.startsWith(SKILL_URI_PREFIX)) return null;
	const name = trimmed.slice(SKILL_URI_PREFIX.length);
	if (!name || /[/:?#]/.test(name)) return null;
	return name;
}

function parseTimestamp(entry: RawEntry): number {
	const ts =
		typeof entry.timestamp === "string"
			? Date.parse(entry.timestamp)
			: Number.NaN;
	return Number.isFinite(ts) ? ts : 0;
}

// ---------------------------------------------------------------------------
// Reflection payload validation (schema v1)
// ---------------------------------------------------------------------------

const STATUSES: Record<ActivityReflectionStatus, true> = {
	success: true,
	invalid: true,
	provider_error: true,
	aborted: true,
};

const REFLECTION_CATEGORIES: Record<
	ActivityReflectionFinding["category"],
	true
> = {
	prompting: true,
	model: true,
	reasoning: true,
	skills: true,
	tools: true,
	workflow: true,
};

const REFLECTION_CONFIDENCES: Record<
	ActivityReflectionFinding["confidence"],
	true
> = {
	low: true,
	medium: true,
	high: true,
};

function parseStart(data: unknown): ActivityReflectionAttemptStart | null {
	if (!isRecord(data)) return null;
	const start = data as Partial<ActivityReflectionAttemptStart>;
	if (start.schemaVersion !== ACTIVITY_REFLECTION_SCHEMA_VERSION) return null;
	if (typeof start.attemptId !== "string" || !start.attemptId) return null;
	if (
		typeof start.sourceSessionId !== "string" ||
		typeof start.project !== "string"
	)
		return null;
	if (typeof start.startedAt !== "number" || !Number.isFinite(start.startedAt))
		return null;
	const model = start.model;
	if (
		!model ||
		typeof model.provider !== "string" ||
		typeof model.id !== "string" ||
		typeof model.api !== "string"
	) {
		return null;
	}
	return start as ActivityReflectionAttemptStart;
}

function parseFinish(data: unknown): ActivityReflectionAttemptFinish | null {
	if (!isRecord(data)) return null;
	const finish = data as Partial<ActivityReflectionAttemptFinish>;
	if (finish.schemaVersion !== ACTIVITY_REFLECTION_SCHEMA_VERSION) return null;
	if (typeof finish.attemptId !== "string" || !finish.attemptId) return null;
	if (
		typeof finish.status !== "string" ||
		!Object.hasOwn(STATUSES, finish.status)
	)
		return null;
	if (
		typeof finish.finishedAt !== "number" ||
		!Number.isFinite(finish.finishedAt)
	)
		return null;
	if (
		typeof finish.durationMs !== "number" ||
		!Number.isFinite(finish.durationMs)
	)
		return null;
	return finish as ActivityReflectionAttemptFinish;
}

/** Keep only structurally valid findings; success is the only status that emits them. */
function sanitizeFindings(findings: unknown): ActivityReflectionFinding[] {
	if (!Array.isArray(findings)) return [];
	const sanitized: ActivityReflectionFinding[] = [];
	for (const raw of findings) {
		if (!isRecord(raw)) continue;
		const finding = raw as Partial<ActivityReflectionFinding>;
		if (
			typeof finding.category !== "string" ||
			!Object.hasOwn(REFLECTION_CATEGORIES, finding.category)
		)
			continue;
		if (
			typeof finding.confidence !== "string" ||
			!Object.hasOwn(REFLECTION_CONFIDENCES, finding.confidence)
		)
			continue;
		const texts = [
			finding.observation,
			finding.evidence,
			finding.suggestion,
			finding.expectedImpact,
		];
		if (
			texts.some((text) => typeof text !== "string" || text.trim().length === 0)
		)
			continue;
		const sourceEntryIds = Array.isArray(finding.sourceEntryIds)
			? finding.sourceEntryIds.filter(
					(id) => typeof id === "string" && id.length > 0,
				)
			: [];
		sanitized.push({
			category: finding.category as ActivityReflectionFinding["category"],
			observation: finding.observation as string,
			evidence: finding.evidence as string,
			suggestion: finding.suggestion as string,
			expectedImpact: finding.expectedImpact as string,
			confidence: finding.confidence as ActivityReflectionFinding["confidence"],
			sourceEntryIds,
		});
	}
	return sanitized;
}

/** Usage totals from a finish; null when malformed (never fabricate rows). */
function usageTotals(
	finish: ActivityReflectionAttemptFinish,
): { totalTokens: number; costTotal: number } | null {
	const usage = finish.usage;
	if (!usage || typeof usage !== "object") return null;
	const tokens = [
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.totalTokens,
	];
	if (
		tokens.some(
			(value) =>
				typeof value !== "number" || !Number.isFinite(value) || value < 0,
		)
	)
		return null;
	const cost = usage.cost;
	const costs = cost
		? [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total]
		: [];
	if (
		costs.some(
			(value) =>
				typeof value !== "number" || !Number.isFinite(value) || value < 0,
		)
	)
		return null;
	return { totalTokens: usage.totalTokens, costTotal: cost?.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Prefix state (incremental fromOffset recovery)
// ---------------------------------------------------------------------------

interface PrefixState {
	serviceTier: ServiceTierByFamily | undefined;
	thinkingLevel: string | null;
	lastTaskEntryId: string | null;
	openStarts: Map<string, ActivityReflectionAttemptStart>;
}

function scanPrefix(bytes: Uint8Array, agentKind: AgentKind): PrefixState {
	const state: PrefixState = {
		serviceTier: undefined,
		thinkingLevel: null,
		lastTaskEntryId: null,
		openStarts: new Map(),
	};
	visitEntries(bytes, (entry) => {
		if (entry.type === "service_tier_change") {
			state.serviceTier = coerceServiceTierByFamily(entry.serviceTier);
			return;
		}
		if (entry.type === "thinking_level_change") {
			state.thinkingLevel =
				typeof entry.thinkingLevel === "string" && entry.thinkingLevel
					? entry.thinkingLevel
					: "off";
			return;
		}
		const msg = messageOf(entry);
		if (msg && isTaskOpeningUser(msg)) {
			const id = entryId(entry);
			if (id) state.lastTaskEntryId = id;
			return;
		}
		if (agentKind === "reflection" && entry.type === "custom") {
			if (entry.customType === ACTIVITY_REFLECTION_START_TYPE) {
				const started = parseStart(entry.data);
				if (started) state.openStarts.set(started.attemptId, started);
			} else if (entry.customType === ACTIVITY_REFLECTION_FINISH_TYPE) {
				const finished = parseFinish(entry.data);
				if (finished) state.openStarts.delete(finished.attemptId);
			}
		}
	});
	return state;
}

// ---------------------------------------------------------------------------
// Main parse
// ---------------------------------------------------------------------------

export async function parseActivitySession(
	sessionPath: string,
	fromOffset = 0,
	sessionsDir = getSessionsDir(),
): Promise<ActivityParseResult> {
	const result: ActivityParseResult = {
		messages: [],
		tasks: [],
		taskProgress: [],
		skills: [],
		toolCalls: [],
		toolResults: [],
		reflections: [],
		newOffset: fromOffset,
	};

	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(sessionPath).bytes();
	} catch (error) {
		if (isEnoent(error)) return result;
		throw error;
	}

	const folder = folderFromPath(sessionPath, sessionsDir);
	const agentKind = classifyAgentKind(sessionPath, sessionsDir);
	const start = Math.max(0, Math.min(fromOffset, bytes.length));
	const prefix: PrefixState =
		start > 0
			? scanPrefix(bytes.subarray(0, start), agentKind)
			: {
					serviceTier: undefined,
					thinkingLevel: null,
					lastTaskEntryId: null,
					openStarts: new Map(),
				};

	let serviceTier = prefix.serviceTier;
	let thinkingLevel = prefix.thinkingLevel;
	let currentTaskId = prefix.lastTaskEntryId;
	const openStarts = prefix.openStarts;
	const progressById = new Map<string, number>();
	const pendingReads = new Map<string, ActivitySkillRow>();
	const erroredReadCallIds = new Set<string>();

	const recordActivity = (eventTs: number) => {
		if (!currentTaskId || !Number.isFinite(eventTs) || eventTs <= 0) return;
		const prev = progressById.get(currentTaskId);
		if (prev === undefined || eventTs > prev)
			progressById.set(currentTaskId, eventTs);
	};

	const read = visitEntries(bytes.subarray(start), (entry) => {
		if (entry.type === "service_tier_change") {
			serviceTier = coerceServiceTierByFamily(entry.serviceTier);
			return;
		}
		if (entry.type === "thinking_level_change") {
			thinkingLevel =
				typeof entry.thinkingLevel === "string" && entry.thinkingLevel
					? entry.thinkingLevel
					: "off";
			return;
		}

		// Reflection sidecar custom entries (our own wire format).
		if (entry.type === "custom" && agentKind === "reflection") {
			if (entry.customType === ACTIVITY_REFLECTION_START_TYPE) {
				const started = parseStart(entry.data);
				if (started) openStarts.set(started.attemptId, started);
			} else if (entry.customType === ACTIVITY_REFLECTION_FINISH_TYPE) {
				const finished = parseFinish(entry.data);
				const started = finished
					? openStarts.get(finished.attemptId)
					: undefined;
				if (finished && started) {
					openStarts.delete(finished.attemptId);
					result.reflections.push({
						sessionFile: sessionPath,
						folder,
						attemptId: finished.attemptId,
						sourceSessionId: started.sourceSessionId,
						project: started.project,
						status: finished.status,
						model: started.model.id,
						provider: started.model.provider,
						startedAt: started.startedAt,
						finishedAt: finished.finishedAt,
						durationMs: finished.durationMs,
						errorCategory:
							typeof finished.errorCategory === "string" &&
							finished.errorCategory
								? finished.errorCategory
								: null,
						findings:
							finished.status === "success"
								? sanitizeFindings(finished.findings)
								: [],
					});
					const totals = usageTotals(finished);
					if (totals) {
						result.messages.push({
							sessionFile: sessionPath,
							entryId: finished.attemptId,
							folder,
							model: started.model.id,
							provider: started.model.provider,
							timestamp: finished.finishedAt,
							totalTokens: totals.totalTokens,
							costTotal: totals.costTotal,
							isError: finished.status === "provider_error",
							thinkingLevel: null,
							priorityRealized: false,
							agentKind: "reflection",
						});
					}
				}
			}
			return;
		}

		// Persisted skill-prompt custom messages (top-level custom_message entries).
		if (
			entry.type === "custom_message" &&
			entry.customType === "skill-prompt"
		) {
			const id = entryId(entry);
			if (!id) return;
			let name = "";
			if (isRecord(entry.details) && typeof entry.details.name === "string")
				name = entry.details.name.trim();
			if (!name) return;
			result.skills.push({
				sessionFile: sessionPath,
				entryId: id,
				toolCallId: null,
				skillName: name,
				source: "prompt",
				timestamp: parseTimestamp(entry),
				confirmed: true,
			});
			return;
		}

		const msg = messageOf(entry);
		if (!msg) return;
		if (msg.role === "user") {
			const id = entryId(entry);
			if (id && isTaskOpeningUser(msg)) {
				result.tasks.push({
					sessionFile: sessionPath,
					entryId: id,
					folder,
					timestamp: parseTimestamp(entry),
					agentKind,
				});
				currentTaskId = id;
			}
			return;
		}

		if (msg.role === "toolResult") {
			const callId =
				typeof msg.toolCallId === "string" && msg.toolCallId
					? msg.toolCallId
					: null;
			if (callId) {
				const isError = msg.isError === true;
				result.toolResults.push({
					sessionFile: sessionPath,
					toolCallId: callId,
					isError,
				});
				// Monotonic in-pass skill-read confirmation.
				const pending = pendingReads.get(callId);
				if (pending && !pending.confirmed) pending.confirmed = !isError;
				if (isError) erroredReadCallIds.add(callId);
			}
			// Completion uses the execution-time nested timestamp when present.
			const nested =
				typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)
					? msg.timestamp
					: null;
			recordActivity(nested ?? parseTimestamp(entry));
			return;
		}

		if (msg.role === "assistant") {
			const id = entryId(entry);
			if (!id) return;
			const model = typeof msg.model === "string" ? msg.model : "";
			const provider = typeof msg.provider === "string" ? msg.provider : "";
			const api = typeof msg.api === "string" ? msg.api : "";
			const usage = isRecord(msg.usage) ? msg.usage : {};
			const totalTokens =
				typeof usage.totalTokens === "number" &&
				Number.isFinite(usage.totalTokens) &&
				usage.totalTokens >= 0
					? usage.totalTokens
					: 0;
			const cost =
				isRecord(usage.cost) &&
				typeof usage.cost.total === "number" &&
				Number.isFinite(usage.cost.total) &&
				usage.cost.total >= 0
					? usage.cost.total
					: 0;
			const timestamp =
				typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)
					? msg.timestamp
					: 0;
			const duration =
				typeof msg.duration === "number" && Number.isFinite(msg.duration)
					? msg.duration
					: 0;
			const modelRef = { provider, api, id: model };
			const tier = resolveModelServiceTier(serviceTier, modelRef);
			const disabled = Array.isArray(msg.disabledFeatures)
				? msg.disabledFeatures
				: [];
			result.messages.push({
				sessionFile: sessionPath,
				entryId: id,
				folder,
				model,
				provider,
				timestamp,
				totalTokens,
				costTotal: cost,
				isError: msg.stopReason === "error",
				thinkingLevel,
				priorityRealized:
					realizesPriorityServiceTier(tier, modelRef) &&
					!disabled.includes("priority"),
				agentKind,
			});
			recordActivity(timestamp + Math.max(0, duration));

			// Tool calls + root skill reads from the content blocks.
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!isRecord(block) || block.type !== "toolCall") continue;
					const callId =
						typeof block.id === "string" && block.id ? block.id : null;
					const toolName = typeof block.name === "string" ? block.name : "";
					if (!callId || !toolName) continue;
					result.toolCalls.push({
						sessionFile: sessionPath,
						entryId: id,
						toolCallId: callId,
						toolName,
						timestamp,
					});
					if (toolName === "read") {
						const args = isRecord(block.arguments) ? block.arguments : {};
						const skillName = rootSkillName(args.path);
						if (skillName) {
							const row: ActivitySkillRow = {
								sessionFile: sessionPath,
								entryId: id,
								toolCallId: callId,
								skillName,
								source: "read",
								timestamp,
								confirmed: false,
							};
							result.skills.push(row);
							pendingReads.set(callId, row);
						}
					}
				}
			}
		}
	});

	for (const [taskEntryId, completedAt] of progressById) {
		result.taskProgress.push({
			sessionFile: sessionPath,
			entryId: taskEntryId,
			completedAt,
		});
	}
	// Errored-only root reads are not activations; unresolved ones stay pending.
	result.skills = result.skills.filter(
		(row) =>
			row.source !== "read" ||
			row.confirmed ||
			!row.toolCallId ||
			!erroredReadCallIds.has(row.toolCallId),
	);
	result.newOffset = start + read;
	return result;
}

/** List every `.jsonl` under the sessions dir (recursive). */
export async function listSessionFiles(
	sessionsDir = getSessionsDir(),
): Promise<string[]> {
	const glob = new Bun.Glob("**/*.jsonl");
	const files: string[] = [];
	try {
		for await (const file of glob.scan({ cwd: sessionsDir, absolute: true })) {
			files.push(file);
		}
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return files.sort();
}
