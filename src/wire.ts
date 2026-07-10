/**
 * Local mirror of oh-my-pi packages/stats/src/reflection-wire.ts.
 * Kept dependency-free so the extension installs against published packages
 * while test/wire.test.ts asserts exact equality against the main-repo source.
 */

export const ACTIVITY_REFLECTION_SCHEMA_VERSION = 1;
export const ACTIVITY_REFLECTION_START_TYPE = "omp.activity-reflection.start";
export const ACTIVITY_REFLECTION_FINISH_TYPE = "omp.activity-reflection.finish";
export const ACTIVITY_REFLECTION_SIDECAR = "__omp-reflect.jsonl";

/** Terminal status of a dispatched reflection attempt. */
export type ActivityReflectionStatus =
	| "success"
	| "invalid"
	| "provider_error"
	| "aborted";

/** Reviewer confidence attached to a single finding. */
export type ActivityReflectionConfidence = "low" | "medium" | "high";

/** Topic bucket a finding files under. */
export type ActivityReflectionCategory =
	| "prompting"
	| "model"
	| "reasoning"
	| "skills"
	| "tools"
	| "workflow";

/** Model that served (or was selected for) the reflection request. */
export interface ActivityReflectionModelRef {
	provider: string;
	id: string;
	api: string;
}

/**
 * Provider usage reported by the reflection request. Structural mirror of the
 * AI package's `Usage` so this module stays dependency-free.
 */
export interface ActivityReflectionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/**
 * Payload of a `omp.activity-reflection.start` custom entry, written before
 * the model request is dispatched.
 */
export interface ActivityReflectionAttemptStart {
	attemptId: string;
	schemaVersion: number;
	/** Stable session id of the audited main session. */
	sourceSessionId: string;
	/** Entry ids of the task windows this attempt audits. */
	sourceEntryIds: string[];
	/** Project path (cwd) the audited session ran in. */
	project: string;
	/** Unix ms when the attempt was dispatched. */
	startedAt: number;
	model: ActivityReflectionModelRef;
}

/** One accepted, sanitized reflection finding. */
export interface ActivityReflectionFinding {
	category: ActivityReflectionCategory;
	observation: string;
	evidence: string;
	suggestion: string;
	expectedImpact: string;
	confidence: ActivityReflectionConfidence;
	/** Entry ids of the audited task windows this finding cites. */
	sourceEntryIds: string[];
}

/**
 * Payload of a `omp.activity-reflection.finish` custom entry. Exactly one
 * finish is written per dispatched attempt. `usage` is present whenever the
 * provider reported usage — including invalid/provider-error responses, which
 * are still billed activity. `findings` is non-empty only for `success`.
 */
export interface ActivityReflectionAttemptFinish {
	attemptId: string;
	schemaVersion: number;
	status: ActivityReflectionStatus;
	/** Unix ms when the attempt settled. */
	finishedAt: number;
	durationMs: number;
	usage?: ActivityReflectionUsage;
	/** Normalized failure category for non-success statuses. Never a raw provider error. */
	errorCategory?: string;
	findings: ActivityReflectionFinding[];
}
