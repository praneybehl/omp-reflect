import type { ActivityDb } from "./db.ts";
import type { ActivityStats } from "./types.ts";

const ACTIVITY_WEEKS = 52;
const REFLECTION_FEED_LIMIT = 20;

/** Local ISO day key, deliberately aligned with SQLite's `localtime` day rollup. */
function localDayKey(date: Date): string {
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function parseLocalDayKey(key: string): Date {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(year, month - 1, day);
}

function addLocalDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Current streak may end yesterday when no task has completed today yet. */
export function computeStreaks(
	activeDays: ReadonlySet<string>,
	today: Date,
): { current: number; longest: number } {
	let longest = 0;
	let run = 0;
	let previous: Date | null = null;
	for (const dayKey of [...activeDays].sort()) {
		const day = parseLocalDayKey(dayKey);
		run =
			previous && localDayKey(addLocalDays(previous, 1)) === dayKey
				? run + 1
				: 1;
		longest = Math.max(longest, run);
		previous = day;
	}

	let current = 0;
	let cursor = activeDays.has(localDayKey(today))
		? today
		: addLocalDays(today, -1);
	while (activeDays.has(localDayKey(cursor))) {
		current++;
		cursor = addLocalDays(cursor, -1);
	}
	return { current, longest };
}

/**
 * Build the complete dashboard payload from extension-owned aggregates only.
 * `now` is an injectable clock seam; the public one-argument contract uses it
 * as the server's current local time.
 */
export function buildActivityStats(
	db: ActivityDb,
	now = new Date(),
): ActivityStats {
	const dayRollup = db.dayRollup();
	const taskDays = db.taskDays();
	const priority = db.priorityCounts();
	const reasoningLevels = db.reasoningLevels();
	const skills = db.skillUsage();
	const longestTask = db.longestTask();
	const models = db.modelUsage();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const currentWeekStart = addLocalDays(today, -today.getDay());
	const windowStart = addLocalDays(currentWeekStart, -(ACTIVITY_WEEKS - 1) * 7);
	const windowStartKey = localDayKey(windowStart);
	const tokensByDay = new Map(dayRollup.map((row) => [row.date, row]));
	const tasksByDay = new Map(taskDays.map((row) => [row.date, row.tasks]));
	const daily: ActivityStats["daily"] = [];

	for (
		let cursor = windowStart;
		cursor <= today;
		cursor = addLocalDays(cursor, 1)
	) {
		const date = localDayKey(cursor);
		const rollup = tokensByDay.get(date);
		daily.push({
			date,
			tokens: rollup?.tokens ?? 0,
			requests: rollup?.requests ?? 0,
			tasks: tasksByDay.get(date) ?? 0,
		});
	}

	const baselineTokens = dayRollup.reduce(
		(total, row) => (row.date < windowStartKey ? total + row.tokens : total),
		0,
	);
	const weekly: ActivityStats["weekly"] = [];
	const cumulative: ActivityStats["cumulative"] = [];
	let runningTokens = baselineTokens;
	for (let index = 0; index < daily.length; index += 7) {
		const week = daily.slice(index, index + 7);
		const weekStart = week[0].date;
		const tokens = week.reduce((total, day) => total + day.tokens, 0);
		const requests = week.reduce((total, day) => total + day.requests, 0);
		const tasks = week.reduce((total, day) => total + day.tasks, 0);
		runningTokens += tokens;
		weekly.push({ weekStart, tokens, requests, tasks });
		cumulative.push({ weekStart, totalTokens: runningTokens });
	}

	let peakDay: ActivityStats["peakDay"] = null;
	for (const row of dayRollup) {
		if (peakDay === null || row.tokens > peakDay.tokens)
			peakDay = { date: row.date, tokens: row.tokens };
	}

	const totalRequests = dayRollup.reduce(
		(total, row) => total + row.requests,
		0,
	);
	const lifetimeTokens = dayRollup.reduce(
		(total, row) => total + row.tokens,
		0,
	);
	const knownRequests = reasoningLevels.reduce(
		(total, level) => total + level.requests,
		0,
	);
	const totalSkillUses = skills.reduce((total, skill) => total + skill.uses, 0);

	return {
		lifetimeTokens,
		totalRequests,
		peakDay,
		streak: computeStreaks(new Set(taskDays.map((row) => row.date)), today),
		longestTask: longestTask
			? {
					durationMs: longestTask.durationMs,
					date: localDayKey(new Date(longestTask.timestamp)),
					folder: longestTask.folder,
				}
			: null,
		totalTasks: db.taskCount(),
		priority: {
			priorityRequests: priority.priorityRequests,
			totalRequests,
			percentage:
				totalRequests > 0 ? priority.priorityRequests / totalRequests : null,
		},
		reasoning: { levels: reasoningLevels, knownRequests, totalRequests },
		skills: {
			distinctSkills: skills.length,
			totalUses: totalSkillUses,
			topSkills: skills,
		},
		models,
		daily,
		weekly,
		cumulative,
		window: {
			start: windowStartKey,
			end: localDayKey(today),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
		},
		reflections: db.reflectionFeed(REFLECTION_FEED_LIMIT),
	};
}
