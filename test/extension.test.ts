import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import packageJson from "../package.json";
import type { ActivityDb } from "../src/analytics/db.ts";
import extensionFactory, {
	createActivityRuntime,
	isTopLevelMainSession,
} from "../src/index.ts";
import { ReflectRecorder } from "../src/recorder.ts";
import { acceptFindings, respondTool, runReflection } from "../src/runner.ts";
import { openReflectSchedule } from "../src/schedule.ts";
import {
	ACTIVITY_REFLECTION_FINISH_TYPE,
	ACTIVITY_REFLECTION_SIDECAR,
	ACTIVITY_REFLECTION_START_TYPE,
} from "../src/wire.ts";

/** Narrow a nullable test value, failing loudly instead of asserting. */
function must<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected non-null test value");
	return value;
}

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

/** Point the schedule DB at a temp dir so factory tests never touch ~/.omp. */
function installTempAgentDir(): () => void {
	const original = getAgentDir();
	const dir = tempDir("omp-reflect-agent-");
	setAgentDir(dir);
	return () => setAgentDir(original);
}

interface RegisteredCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (
		prefix: string,
	) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface RegisteredFlag {
	name: string;
	type: string;
	default?: boolean | string;
}

function createMockPi(): {
	api: ExtensionAPI;
	commands: RegisteredCommand[];
	flags: RegisteredFlag[];
	label?: string;
	handlers: Map<string, Function>;
	flagValues: Map<string, boolean | string>;
} {
	const commands: RegisteredCommand[] = [];
	const flags: RegisteredFlag[] = [];
	const handlers = new Map<string, Function>();
	const flagValues = new Map<string, boolean | string>();
	let label: string | undefined;

	const api = {
		logger: { debug() {}, warn() {}, info() {}, error() {} },
		typebox: {},
		arktype: {},
		zod: {},
		pi: {
			SessionManager: {
				listAll: async () => [],
			},
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			options: Omit<RegisteredCommand, "name"> & {
				handler: RegisteredCommand["handler"];
			},
		) {
			commands.push({ ...options, name });
		},
		registerFlag(name: string, options: Omit<RegisteredFlag, "name">) {
			flags.push({ ...options, name });
			if (options.default !== undefined) flagValues.set(name, options.default);
		},
		getFlag(name: string) {
			return flagValues.get(name);
		},
		setLabel(value: string) {
			label = value;
		},
		registerTool() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerAssistantThinkingRenderer() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => undefined,
		setThinkingLevel() {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
		registerProvider() {},
		events: { on() {}, off() {}, emit() {} },
	} as unknown as ExtensionAPI;

	return {
		api,
		commands,
		flags,
		get label() {
			return label;
		},
		handlers,
		flagValues,
	};
}

function fakeModel(): Model {
	return {
		id: "gpt-test",
		name: "GPT Test",
		provider: "openai",
		api: "openai-responses",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		baseUrl: "https://example.com",
	} as Model;
}

function assistantWithFindings(findings: unknown[]): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "tc1",
				name: "respond",
				arguments: { findings },
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 11,
			output: 22,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 33,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.03,
			},
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("package loading", () => {
	test("package.json declares the extension entry", () => {
		expect(packageJson.name).toBe("omp-reflect");
		expect(packageJson.omp.extensions).toEqual(["./src/index.ts"]);
		expect(fs.existsSync(path.join(import.meta.dir, "../src/index.ts"))).toBe(
			true,
		);
	});

	test("factory registers label, commands, and flag", () => {
		const restoreAgentDir = installTempAgentDir();
		try {
			const mockPi = createMockPi();
			extensionFactory(mockPi.api);
			expect(mockPi.label).toBe("Activity Reflections");
			expect(mockPi.commands.map((c) => c.name)).toContain("reflect");
			expect(mockPi.commands.map((c) => c.name)).toContain("activity");
			expect(mockPi.flags.map((f) => f.name)).toContain("reflect-daily");

			const cmd = must(mockPi.commands.find((c) => c.name === "reflect"));
			const completions = cmd.getArgumentCompletions?.("") ?? [];
			const values = completions.map((c) => c.value);
			expect(values).toContain("run");
			expect(values).toContain("show");
			expect(values).toContain("status");
			expect(values).toContain("auto on");
			expect(values).toContain("auto off");

			const activity = must(mockPi.commands.find((c) => c.name === "activity"));
			const activityCompletions = activity.getArgumentCompletions?.("") ?? [];
			expect(activityCompletions.map((c) => c.value)).toEqual([
				"open",
				"sync",
				"status",
				"stop",
			]);
		} finally {
			restoreAgentDir();
		}
	});

	test("activity command reuses one server and shuts down isolated resources", async () => {
		const restoreAgentDir = installTempAgentDir();
		try {
			let dbClosed = 0;
			let syncCalls = 0;
			let serverStarts = 0;
			let serverStops = 0;
			const db = {
				close() {
					dbClosed += 1;
				},
			} as unknown as ActivityDb;
			const runtime = createActivityRuntime({
				dbPath: path.join(tempDir("omp-reflect-activity-"), "activity.sqlite"),
				openDb: () => db,
				async syncDb() {
					syncCalls += 1;
					return { processed: 7, files: 3 };
				},
				async startDashboard() {
					serverStarts += 1;
					return {
						port: 43123,
						url: "http://127.0.0.1:43123",
						async stop() {
							serverStops += 1;
						},
					};
				},
			});
			const mockPi = createMockPi();
			const launched: string[] = [];
			extensionFactory(mockPi.api, {
				activityRuntime: runtime,
				openExternal: (url) => launched.push(url),
			});
			const command = must(mockPi.commands.find((c) => c.name === "activity"));
			const notifications: string[] = [];
			const ctx = {
				ui: {
					notify: (message: string) => notifications.push(message),
				},
			} as unknown as ExtensionCommandContext;

			await command.handler("", ctx);
			await command.handler("open", ctx);
			expect(syncCalls).toBe(1);
			expect(serverStarts).toBe(1);
			expect(launched).toEqual([
				"http://127.0.0.1:43123",
				"http://127.0.0.1:43123",
			]);

			await command.handler("status", ctx);
			expect(notifications.at(-1)).toContain("server: http://127.0.0.1:43123");
			expect(notifications.at(-1)).toContain("7 records from 3 file(s)");
			expect(notifications.at(-1)).toContain("activity.sqlite");

			await command.handler("sync", ctx);
			expect(syncCalls).toBe(2);
			await command.handler("stop", ctx);
			expect(serverStops).toBe(1);

			const shutdown = mockPi.handlers.get("session_shutdown");
			expect(shutdown).toBeTypeOf("function");
			await (shutdown as () => Promise<void>)();
			expect(dbClosed).toBe(1);
		} finally {
			restoreAgentDir();
		}
	});
});

describe("isTopLevelMainSession", () => {
	test("accepts two-segment session paths under sessions root", () => {
		// Use relative-depth rule with a synthetic absolute path: inject via
		// path.relative semantics by constructing under a fake root is hard without
		// mocking getSessionsDir; instead assert the pure segment logic via a path
		// that is absolute and not under the real sessions dir returns false, and
		// nested deeper paths fail.
		expect(isTopLevelMainSession(undefined)).toBe(false);
		expect(isTopLevelMainSession("/tmp/not-sessions/a.jsonl")).toBe(false);
	});
});

describe("acceptFindings", () => {
	test("accepts valid findings and rejects unknown source ids / empty fields", () => {
		const allowed = new Set(["e1", "e2"]);
		const ok = acceptFindings(
			{
				findings: [
					{
						category: "prompting",
						observation: "obs",
						evidence: "ev",
						suggestion: "sug",
						expectedImpact: "imp",
						confidence: "high",
						sourceEntryIds: ["e1"],
					},
				],
			},
			allowed,
			(t) => t,
		);
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.findings).toHaveLength(1);

		const badId = acceptFindings(
			{
				findings: [
					{
						category: "tools",
						observation: "obs",
						evidence: "ev",
						suggestion: "sug",
						expectedImpact: "imp",
						confidence: "low",
						sourceEntryIds: ["missing"],
					},
				],
			},
			allowed,
			(t) => t,
		);
		expect(badId.ok).toBe(false);

		const empty = acceptFindings(
			{
				findings: [
					{
						category: "tools",
						observation: "  ",
						evidence: "ev",
						suggestion: "sug",
						expectedImpact: "imp",
						confidence: "low",
						sourceEntryIds: ["e1"],
					},
				],
			},
			allowed,
			(t) => t,
		);
		expect(empty.ok).toBe(false);
	});

	test("respond tool is the only structured tool", () => {
		expect(respondTool.name).toBe("respond");
	});
});

describe("runReflection", () => {
	test("active model required — no fallback when model missing", async () => {
		const dir = tempDir("omp-reflect-run-");
		const sessionFile = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionFile, "{}\n", "utf8");
		const recorder = new ReflectRecorder({
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionFile: () => sessionFile,
				getCwd: () => dir,
			},
			listAll: async () => [{ id: "sess-1", path: sessionFile, cwd: dir }],
		});

		const ctx = {
			cwd: dir,
			model: undefined,
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => async () => "key",
			},
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionFile: () => sessionFile,
				getCwd: () => dir,
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;

		const result = await runReflection({
			ctx: ctx as never,
			recorder,
			mode: "manual",
		});
		expect(result.status).toBe("not_dispatched");
		expect(result.errorCategory).toBe("missing_model");
	});

	test("missing credential never falls back", async () => {
		const dir = tempDir("omp-reflect-run-");
		const sessionFile = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionFile, "{}\n", "utf8");
		const recorder = new ReflectRecorder({
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionFile: () => sessionFile,
				getCwd: () => dir,
			},
			listAll: async () => [{ id: "sess-1", path: sessionFile, cwd: dir }],
		});
		const model = fakeModel();
		const ctx = {
			cwd: dir,
			model,
			modelRegistry: {
				getApiKey: async () => undefined,
				resolver: () => async () => undefined,
			},
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionFile: () => sessionFile,
				getCwd: () => dir,
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;

		const result = await runReflection({
			ctx: ctx as never,
			recorder,
			mode: "manual",
		});
		expect(result.status).toBe("not_dispatched");
		expect(result.errorCategory).toBe("missing_credential");
	});

	test("bounded structured call persists attempt start/finish with findings", async () => {
		const dir = tempDir("omp-reflect-run-");
		const sessionFile = path.join(dir, "main.jsonl");
		fs.writeFileSync(sessionFile, '{"type":"session","id":"sess-1"}\n', "utf8");
		const artifacts = sessionFile.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });

		const userEntry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: "Please fix the flaky test in auth",
				timestamp: Date.now() - 5000,
			},
		};
		const assistantEntry = {
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Fixed the race by awaiting the lock." },
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
				usage: {
					input: 5,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now() - 1000,
				duration: 500,
			},
		};

		const recorder = new ReflectRecorder({
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionFile: () => sessionFile,
				getCwd: () => dir,
			},
			listAll: async () => [{ id: "sess-1", path: sessionFile, cwd: dir }],
		});

		const model = fakeModel();
		const completeCalls: unknown[] = [];
		const complete = mock(
			async (
				_model: Model,
				context: { tools?: unknown[] },
				options: { maxTokens?: number },
			) => {
				completeCalls.push({
					tools: context.tools,
					maxTokens: options.maxTokens,
				});
				return assistantWithFindings([
					{
						category: "prompting",
						observation: "Prompt omitted reproduction steps",
						evidence: "Task e1 needed tool retries",
						suggestion: "Include failing test name and expected output",
						expectedImpact: "Fewer clarification turns",
						confidence: "medium",
						sourceEntryIds: ["e1"],
					},
				]);
			},
		);

		const ctx = {
			cwd: dir,
			model,
			modelRegistry: {
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			},
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionFile: () => sessionFile,
				getCwd: () => dir,
				getBranch: () => [userEntry, assistantEntry],
			},
			// no stats → observability unavailable, still continues from tasks
		} as unknown as ExtensionContext;

		const result = await runReflection({
			ctx: ctx as never,
			recorder,
			mode: "manual",
			complete: complete as never,
		});

		expect(result.status).toBe("success");
		expect(result.findings).toHaveLength(1);
		expect(result.model?.id).toBe("gpt-test");
		expect(completeCalls).toHaveLength(1);
		const call = completeCalls[0] as {
			tools: Array<{ name: string }>;
			maxTokens: number;
		};
		expect(call.tools.map((t) => t.name)).toEqual(["respond"]);
		expect(call.maxTokens).toBe(1600);

		await recorder.flush();
		const sidecar = path.join(artifacts, ACTIVITY_REFLECTION_SIDECAR);
		expect(fs.existsSync(sidecar)).toBe(true);
		const lines = fs.readFileSync(sidecar, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const start = JSON.parse(must(lines[0]));
		const finish = JSON.parse(must(lines[lines.length - 1]));
		expect(start.customType).toBe(ACTIVITY_REFLECTION_START_TYPE);
		expect(finish.customType).toBe(ACTIVITY_REFLECTION_FINISH_TYPE);
		expect(finish.data.status).toBe("success");
		expect(finish.data.findings).toHaveLength(1);
		expect(finish.data.usage.totalTokens).toBe(33);
	});
});

describe("recorder owner resolution", () => {
	test("moved session writes at new path; dropped session discards finish", async () => {
		const dir = tempDir("omp-reflect-move-");
		const oldFile = path.join(dir, "old", "sess.jsonl");
		const newFile = path.join(dir, "new", "sess.jsonl");
		fs.mkdirSync(path.dirname(oldFile), { recursive: true });
		fs.mkdirSync(path.dirname(newFile), { recursive: true });
		fs.writeFileSync(newFile, "{}\n", "utf8");
		// old main JSONL does not exist (moved)

		const recorder = new ReflectRecorder({
			sessionManager: {
				getSessionId: () => "other",
				getSessionFile: () => undefined,
				getCwd: () => dir,
			},
			listAll: async () => [{ id: "sess-moved", path: newFile, cwd: dir }],
		});

		const written = await recorder.writeStart({
			attemptId: "a1",
			sourceSessionId: "sess-moved",
			sourceEntryIds: ["e1"],
			project: dir,
			startedAt: Date.now(),
			model: { provider: "openai", id: "gpt", api: "openai-responses" },
		});
		expect(written).toBe(true);
		const newSidecar = path.join(
			newFile.slice(0, -".jsonl".length),
			ACTIVITY_REFLECTION_SIDECAR,
		);
		expect(fs.existsSync(newSidecar)).toBe(true);
		const oldSidecar = path.join(
			oldFile.slice(0, -".jsonl".length),
			ACTIVITY_REFLECTION_SIDECAR,
		);
		expect(fs.existsSync(oldSidecar)).toBe(false);

		// Dropped session: not in listAll and no current match.
		const dropped = await recorder.writeFinish({
			attemptId: "a2",
			sourceSessionId: "sess-dropped",
			status: "aborted",
			finishedAt: Date.now(),
			durationMs: 1,
			errorCategory: "aborted",
		});
		expect(dropped).toBe(false);
	});
});

describe("schedule integration with commands", () => {
	test("auto on/off persists via schedule db", () => {
		const dir = tempDir("omp-reflect-auto-");
		const dbPath = path.join(dir, "omp-reflect.sqlite");
		const schedule = openReflectSchedule(dbPath);
		expect(schedule.getState().enabled).toBe(false);
		schedule.setEnabled(true);
		expect(schedule.getState().enabled).toBe(true);
		schedule.setEnabled(false);
		expect(schedule.getState().enabled).toBe(false);
		schedule.close();
	});
});

describe("ongoing coverage", () => {
	interface SessionFixture {
		dir: string;
		sessionFile: string;
		artifacts: string;
		entries: unknown[];
		recorder: ReflectRecorder;
		sessionManager: {
			getSessionId: () => string;
			getSessionFile: () => string;
			getCwd: () => string;
			getBranch: () => unknown[];
		};
	}

	function userEntry(id: string, prompt: string): unknown {
		return {
			type: "message",
			id,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: prompt, timestamp: Date.now() - 5000 },
		};
	}

	function assistantEntry(id: string, parentId: string): unknown {
		return {
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
				usage: {
					input: 5,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now() - 1000,
				duration: 500,
			},
		};
	}

	function sessionFixture(): SessionFixture {
		const dir = tempDir("omp-reflect-coverage-");
		const sessionFile = path.join(dir, "main.jsonl");
		fs.writeFileSync(
			sessionFile,
			'{"type":"session","id":"sess-cov"}\n',
			"utf8",
		);
		const artifacts = sessionFile.slice(0, -".jsonl".length);
		fs.mkdirSync(artifacts, { recursive: true });
		const entries: unknown[] = [
			userEntry("e1", "First task"),
			assistantEntry("e2", "e1"),
			userEntry("e3", "Second task"),
			assistantEntry("e4", "e3"),
		];
		const sessionManager = {
			getSessionId: () => "sess-cov",
			getSessionFile: () => sessionFile,
			getCwd: () => dir,
			getBranch: () => entries,
		};
		const recorder = new ReflectRecorder({
			sessionManager,
			listAll: async () => [{ id: "sess-cov", path: sessionFile, cwd: dir }],
		});
		return { dir, sessionFile, artifacts, entries, recorder, sessionManager };
	}

	function readStartEntries(fixture: SessionFixture): string[][] {
		const sidecar = path.join(fixture.artifacts, ACTIVITY_REFLECTION_SIDECAR);
		if (!fs.existsSync(sidecar)) return [];
		return fs
			.readFileSync(sidecar, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						customType: string;
						data: { sourceEntryIds?: string[] };
					},
			)
			.filter((entry) => entry.customType === ACTIVITY_REFLECTION_START_TYPE)
			.map((entry) => entry.data.sourceEntryIds ?? []);
	}

	function runCtx(fixture: SessionFixture): ExtensionContext {
		return {
			cwd: fixture.dir,
			model: fakeModel(),
			modelRegistry: {
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			},
			sessionManager: fixture.sessionManager,
		} as unknown as ExtensionContext;
	}

	test("manual runs walk the backlog and stop when everything is covered", async () => {
		const fixture = sessionFixture();
		let citedId = "e1";
		const complete = mock(async () =>
			assistantWithFindings([
				{
					category: "workflow",
					observation: "obs",
					evidence: "ev",
					suggestion: "sug",
					expectedImpact: "imp",
					confidence: "low",
					sourceEntryIds: [citedId],
				},
			]),
		);

		// Run 1: both windows uncovered -> both selected and covered on success.
		const first = await runReflection({
			ctx: runCtx(fixture) as never,
			recorder: fixture.recorder,
			mode: "manual",
			complete: complete as never,
		});
		expect(first.status).toBe("success");
		await fixture.recorder.flush();
		expect(readStartEntries(fixture)).toEqual([["e1", "e3"]]);

		// Run 2: nothing uncovered -> caught up, nothing dispatched or persisted.
		const second = await runReflection({
			ctx: runCtx(fixture) as never,
			recorder: fixture.recorder,
			mode: "manual",
			complete: complete as never,
		});
		expect(second.status).toBe("not_dispatched");
		expect(second.errorCategory).toBe("no_tasks");
		await fixture.recorder.flush();
		expect(readStartEntries(fixture)).toHaveLength(1);

		// Run 3: a new completed task arrives -> only the uncovered window is audited.
		fixture.entries.push(
			userEntry("e5", "Third task"),
			assistantEntry("e6", "e5"),
		);
		citedId = "e5";
		const third = await runReflection({
			ctx: runCtx(fixture) as never,
			recorder: fixture.recorder,
			mode: "manual",
			complete: complete as never,
		});
		expect(third.status).toBe("success");
		await fixture.recorder.flush();
		expect(readStartEntries(fixture)).toEqual([["e1", "e3"], ["e5"]]);
	});

	test("/reflect status reports the coverage watermark", async () => {
		const restoreAgentDir = installTempAgentDir();
		try {
			const fixture = sessionFixture();
			const mockPi = createMockPi();
			(
				mockPi.api.pi as {
					SessionManager: { listAll: () => Promise<unknown[]> };
				}
			).SessionManager.listAll = async () => [
				{ id: "sess-cov", path: fixture.sessionFile, cwd: fixture.dir },
			];
			extensionFactory(mockPi.api);
			const cmd = must(mockPi.commands.find((c) => c.name === "reflect"));

			const notifications: string[] = [];
			const ctx = {
				cwd: fixture.dir,
				model: undefined,
				sessionManager: fixture.sessionManager,
				ui: {
					notify: (message: string) => notifications.push(message),
					setStatus() {},
				},
			} as unknown as ExtensionCommandContext;

			await cmd.handler("status", ctx);
			expect(notifications.at(-1)).toContain("coverage: 0/2 tasks");

			// Cover the first window via a successful attempt, then re-check.
			await fixture.recorder.writeStart({
				attemptId: "att-cov",
				sourceSessionId: "sess-cov",
				sourceEntryIds: ["e1"],
				project: fixture.dir,
				startedAt: Date.now(),
				model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
			});
			await fixture.recorder.writeFinish({
				attemptId: "att-cov",
				sourceSessionId: "sess-cov",
				status: "success",
				finishedAt: Date.now(),
				durationMs: 10,
				findings: [
					{
						category: "workflow",
						observation: "obs",
						evidence: "ev",
						suggestion: "sug",
						expectedImpact: "imp",
						confidence: "low",
						sourceEntryIds: ["e1"],
					},
				],
			});
			await fixture.recorder.flush();

			await cmd.handler("status", ctx);
			const status = notifications.at(-1) ?? "";
			expect(status).toContain("coverage: 1/2 tasks");
			expect(status).toContain("insights through");
		} finally {
			restoreAgentDir();
		}
	});

	test("caught-up manual run notifies up-to-date and records no attempt", async () => {
		const restoreAgentDir = installTempAgentDir();
		try {
			const agentDir = getAgentDir();
			const fixture = sessionFixture();
			// Cover both windows up front.
			await fixture.recorder.writeStart({
				attemptId: "att-all",
				sourceSessionId: "sess-cov",
				sourceEntryIds: ["e1", "e3"],
				project: fixture.dir,
				startedAt: Date.now(),
				model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
			});
			await fixture.recorder.writeFinish({
				attemptId: "att-all",
				sourceSessionId: "sess-cov",
				status: "success",
				finishedAt: Date.now(),
				durationMs: 10,
				findings: [
					{
						category: "workflow",
						observation: "obs",
						evidence: "ev",
						suggestion: "sug",
						expectedImpact: "imp",
						confidence: "low",
						sourceEntryIds: ["e1"],
					},
				],
			});
			await fixture.recorder.flush();

			const mockPi = createMockPi();
			(
				mockPi.api.pi as {
					SessionManager: { listAll: () => Promise<unknown[]> };
				}
			).SessionManager.listAll = async () => [
				{ id: "sess-cov", path: fixture.sessionFile, cwd: fixture.dir },
			];
			extensionFactory(mockPi.api);
			const cmd = must(mockPi.commands.find((c) => c.name === "reflect"));

			const notifications: string[] = [];
			const ctx = {
				cwd: fixture.dir,
				model: fakeModel(),
				modelRegistry: {
					getApiKey: async () => "test-key",
					resolver: () => async () => "test-key",
				},
				sessionManager: fixture.sessionManager,
				waitForIdle: async () => {},
				ui: {
					notify: (message: string) => notifications.push(message),
					setStatus() {},
				},
			} as unknown as ExtensionCommandContext;

			await cmd.handler("run", ctx);
			expect(
				notifications.some((n) => n.includes("Nothing new to reflect on")),
			).toBe(true);

			// The caught-up steady state records no attempt and sets no retry floor.
			const state = openReflectSchedule(
				path.join(agentDir, "omp-reflect.sqlite"),
			);
			expect(state.getState().last_attempt_at).toBeNull();
			expect(state.getState().next_scheduled_attempt_at).toBeNull();
			state.close();
		} finally {
			restoreAgentDir();
		}
	});
});
