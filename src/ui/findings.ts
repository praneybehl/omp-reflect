import type { ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import type { ActivityReflectionFinding } from "../wire.ts";

export const NO_REFLECTIONS_YET = "No reflections yet. Run /reflect run.";

/**
 * Format accepted findings for `ctx.ui.select()`: observation as label,
 * evidence + suggestion as description.
 */
export function findingsToSelectOptions(
	findings: ActivityReflectionFinding[],
): ExtensionUISelectOption[] {
	return findings.map((finding) => ({
		label: finding.observation,
		description: `${finding.evidence} → ${finding.suggestion}`,
	}));
}

/** One-line summary used in notifications. */
export function formatFindingSummary(
	finding: ActivityReflectionFinding,
): string {
	return `[${finding.category}/${finding.confidence}] ${finding.observation}`;
}
