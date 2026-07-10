import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	TextContent,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { ReflectionObservabilitySnapshot } from "./observability.ts";

export const USER_PROMPT_LIMIT = 2_000;
export const ASSISTANT_ANSWER_LIMIT = 3_000;
export const COMPLETE_PAYLOAD_LIMIT = 24_000;
export const TASK_BATCH_LIMIT = 6;

export interface TaskToolSummary {
	name: string;
	count: number;
	errors: number;
}

export interface TaskWindow {
	/** Entry id of the top-level user message that opened the task. */
	sourceEntryId: string;
	/** Truncated user prompt text. */
	userPrompt: string;
	/** Truncated final assistant answer text (may be empty). */
	assistantAnswer: string;
	/** Effective reasoning / thinking level when known. */
	thinkingLevel?: string;
	/** Provider usage from the last assistant message, when present. */
	usage?: Pick<
		Usage,
		"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"
	> & {
		cost?: Usage["cost"];
	};
	/** Elapsed ms from user message to last assistant/tool-result event. */
	elapsedMs: number;
	/** Tool call names/counts/errors inside the window. */
	tools: TaskToolSummary[];
	/** Canonical skill names activated in the window. */
	skills: string[];
	/** ISO timestamp of the user message. */
	startedAt: string;
}

export interface ReflectionTaskSnapshot {
	tasks: TaskWindow[];
	observability: ReflectionObservabilitySnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…`;
}

function isSyntheticUser(message: AgentMessage): boolean {
	if (message.role !== "user") return false;
	const synthetic = "synthetic" in message ? message.synthetic : false;
	const attribution =
		"attribution" in message ? message.attribution : undefined;
	return synthetic === true || attribution === "agent";
}

function isTopLevelUserMessage(message: AgentMessage): boolean {
	return message.role === "user" && !isSyntheticUser(message);
}

function collectSkills(
	entries: SessionEntry[],
	from: number,
	to: number,
): string[] {
	const names = new Set<string>();
	for (let i = from; i <= to; i++) {
		const entry = entries[i];
		if (!entry) continue;
		if (
			entry.type === "custom_message" &&
			entry.customType === "skill-prompt"
		) {
			const details = entry.details;
			if (
				isRecord(details) &&
				typeof details.name === "string" &&
				details.name.length > 0
			) {
				names.add(details.name);
			}
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const assistant = entry.message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type !== "toolCall") continue;
				const call = block as ToolCall;
				if (call.name !== "read") continue;
				const pathArg = call.arguments?.path;
				if (typeof pathArg === "string" && pathArg.startsWith("skill://")) {
					const skillName = pathArg.slice("skill://".length).split("/")[0];
					if (skillName) names.add(skillName);
				}
			}
		}
	}
	return [...names].sort();
}

function collectTools(
	entries: SessionEntry[],
	from: number,
	to: number,
): TaskToolSummary[] {
	const byName = new Map<string, TaskToolSummary>();
	const callIds = new Map<string, string>();
	for (let i = from; i <= to; i++) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant") {
			const assistant = msg as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type !== "toolCall") continue;
				const call = block as ToolCall;
				const current = byName.get(call.name) ?? {
					name: call.name,
					count: 0,
					errors: 0,
				};
				current.count += 1;
				byName.set(call.name, current);
				callIds.set(call.id, call.name);
			}
		} else if (msg.role === "toolResult") {
			const toolName = callIds.get(msg.toolCallId);
			if (!toolName) continue;
			if (msg.isError) {
				const current = byName.get(toolName) ?? {
					name: toolName,
					count: 0,
					errors: 0,
				};
				current.errors += 1;
				byName.set(toolName, current);
			}
		}
	}
	return [...byName.values()].sort(
		(a, b) => b.count - a.count || a.name.localeCompare(b.name),
	);
}

function lastAssistantAnswer(
	entries: SessionEntry[],
	from: number,
	to: number,
): {
	text: string;
	usage?: TaskWindow["usage"];
	thinkingLevel?: string;
	endMs: number;
} {
	let text = "";
	let usage: TaskWindow["usage"];
	let thinkingLevel: string | undefined;
	let endMs = 0;
	for (let i = from; i <= to; i++) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.type === "thinking_level_change") {
			if (
				typeof entry.thinkingLevel === "string" &&
				entry.thinkingLevel.length > 0
			) {
				thinkingLevel = entry.thinkingLevel;
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant") {
			const assistant = msg as AssistantMessage;
			const answer = textFromContent(assistant.content as TextContent[]);
			if (answer.trim().length > 0) text = answer;
			if (assistant.usage) {
				usage = {
					input: assistant.usage.input,
					output: assistant.usage.output,
					cacheRead: assistant.usage.cacheRead,
					cacheWrite: assistant.usage.cacheWrite,
					totalTokens: assistant.usage.totalTokens,
					cost: assistant.usage.cost,
				};
			}
			const ts =
				typeof assistant.timestamp === "number"
					? assistant.timestamp
					: Date.parse(entry.timestamp);
			const duration =
				typeof assistant.duration === "number" ? assistant.duration : 0;
			endMs = Math.max(endMs, ts + duration);
		} else if (msg.role === "toolResult") {
			const ts =
				typeof msg.timestamp === "number"
					? msg.timestamp
					: Date.parse(entry.timestamp);
			endMs = Math.max(endMs, ts);
		}
	}
	return { text, usage, thinkingLevel, endMs };
}

/**
 * Group branch entries into completed non-synthetic top-level user-task windows.
 * A window is complete when a later top-level user message exists, or when the
 * branch ends after at least one assistant/tool-result event.
 */
export function extractTaskWindows(entries: SessionEntry[]): TaskWindow[] {
	const userIndexes: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		if (isTopLevelUserMessage(entry.message)) userIndexes.push(i);
	}

	const windows: TaskWindow[] = [];
	for (let u = 0; u < userIndexes.length; u++) {
		const start = userIndexes[u];
		if (start === undefined) continue;
		const next = userIndexes[u + 1];
		const nextUser = next === undefined ? entries.length : next;
		const end = nextUser - 1;
		const startEntry = entries[start];
		if (startEntry?.type !== "message") continue;
		const userMsg = startEntry.message;
		if (userMsg.role !== "user") continue;

		const hasActivity = (() => {
			for (let i = start + 1; i <= end; i++) {
				const e = entries[i];
				if (e?.type !== "message") continue;
				if (e.message.role === "assistant" || e.message.role === "toolResult")
					return true;
			}
			return false;
		})();
		// Incomplete open task (no activity yet) is skipped.
		if (!hasActivity) continue;

		const startMs =
			typeof userMsg.timestamp === "number"
				? userMsg.timestamp
				: Date.parse(startEntry.timestamp);
		const assistant = lastAssistantAnswer(entries, start + 1, end);
		const elapsedMs = Math.max(0, (assistant.endMs || startMs) - startMs);

		windows.push({
			sourceEntryId: startEntry.id,
			userPrompt: truncate(textFromContent(userMsg.content), USER_PROMPT_LIMIT),
			assistantAnswer: truncate(assistant.text, ASSISTANT_ANSWER_LIMIT),
			thinkingLevel: assistant.thinkingLevel,
			usage: assistant.usage,
			elapsedMs,
			tools: collectTools(entries, start + 1, end),
			skills: collectSkills(entries, start, end),
			startedAt: startEntry.timestamp,
		});
	}
	return windows;
}

/**
 * Select the next batch of task windows for an audit — an ongoing process,
 * not a one-off event. Both manual and scheduled runs are coverage-aware:
 * windows whose source ids were already covered by a successful reflection
 * (the sidecar is the durable watermark) are skipped, and the newest
 * {@link TASK_BATCH_LIMIT} uncovered windows are taken. Repeated runs
 * therefore walk backward through the backlog until everything is covered;
 * the batch bound exists only to protect the per-attempt payload budget.
 */
export function selectTaskWindows(
	windows: TaskWindow[],
	coveredSourceIds?: ReadonlySet<string>,
): TaskWindow[] {
	const covered = coveredSourceIds ?? new Set<string>();
	return windows
		.filter((w) => !covered.has(w.sourceEntryId))
		.slice(-TASK_BATCH_LIMIT);
}

/**
 * Bound the complete reflection payload (including observability JSON) to
 * COMPLETE_PAYLOAD_LIMIT characters by progressively trimming task text.
 */
export function buildBoundedPayload(
	tasks: TaskWindow[],
	observability: ReflectionObservabilitySnapshot,
): {
	tasks: TaskWindow[];
	observability: ReflectionObservabilitySnapshot;
	json: string;
} {
	const cloneTasks = (): TaskWindow[] =>
		tasks.map((t) => ({
			...t,
			tools: t.tools.map((x) => ({ ...x })),
			skills: [...t.skills],
		}));

	let current = cloneTasks();
	let obs: ReflectionObservabilitySnapshot = observability;
	const encode = () =>
		JSON.stringify({
			tasks: current,
			observability: obs,
		});

	let json = encode();
	if (json.length <= COMPLETE_PAYLOAD_LIMIT) {
		return { tasks: current, observability: obs, json };
	}

	// Drop matrices first when over budget while keeping status.
	if (obs.status === "ok") {
		obs = {
			status: "ok",
			source: obs.source,
			behavior30d: obs.behavior30d,
			behaviorAll: obs.behaviorAll,
			gainOverall: obs.gainOverall,
		};
		json = encode();
	}

	// Progressively shrink task text.
	while (json.length > COMPLETE_PAYLOAD_LIMIT && current.length > 0) {
		let shrunk = false;
		for (const task of current) {
			if (task.assistantAnswer.length > 200) {
				task.assistantAnswer = truncate(
					task.assistantAnswer,
					Math.floor(task.assistantAnswer.length / 2),
				);
				shrunk = true;
			} else if (task.userPrompt.length > 200) {
				task.userPrompt = truncate(
					task.userPrompt,
					Math.floor(task.userPrompt.length / 2),
				);
				shrunk = true;
			}
		}
		json = encode();
		if (!shrunk) break;
	}

	// Drop oldest tasks if still over budget.
	while (json.length > COMPLETE_PAYLOAD_LIMIT && current.length > 1) {
		current = current.slice(1);
		json = encode();
	}

	// Last resort: strip observability matrices entirely.
	if (json.length > COMPLETE_PAYLOAD_LIMIT) {
		obs = {
			status: observability.status,
			source: observability.source,
			error: observability.error,
		};
		json = encode();
	}

	return { tasks: current, observability: obs, json };
}

export function mergeTaskSnapshot(
	tasks: TaskWindow[],
	observability: ReflectionObservabilitySnapshot,
): ReflectionTaskSnapshot {
	const bounded = buildBoundedPayload(tasks, observability);
	return { tasks: bounded.tasks, observability: bounded.observability };
}
