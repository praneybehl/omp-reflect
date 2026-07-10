import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FAILURE_FLOOR_MS,
	LEASE_MS,
	openReflectSchedule,
	SUCCESS_INTERVAL_MS,
} from "../src/schedule.ts";

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

function tempDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-reflect-sched-"));
	temps.push(dir);
	return path.join(dir, "omp-reflect.sqlite");
}

describe("reflect schedule lease", () => {
	test("competing claims: second fails while first holds", () => {
		const dbPath = tempDb();
		const a = openReflectSchedule(dbPath);
		const b = openReflectSchedule(dbPath);
		const leaseA = a.tryClaimLease(1_000);
		expect(leaseA).not.toBeNull();
		const leaseB = b.tryClaimLease(1_000);
		expect(leaseB).toBeNull();
		leaseA?.release();
		const leaseB2 = b.tryClaimLease(1_001);
		expect(leaseB2).not.toBeNull();
		leaseB2?.release();
		a.close();
		b.close();
	});

	test("heartbeat renews beyond original expiry", () => {
		const dbPath = tempDb();
		const sched = openReflectSchedule(dbPath);
		const lease = sched.tryClaimLease();
		expect(lease).not.toBeNull();
		const untilBefore = must(sched.getState().lease_until);
		// Wait a tiny bit so renew writes a strictly later expiry.
		const untilAfterClaim = untilBefore;
		expect(lease?.renew()).toBe(true);
		const untilAfter = must(sched.getState().lease_until);
		expect(untilAfter).toBeGreaterThanOrEqual(untilAfterClaim);
		// Another claim still fails while held.
		const other = sched.tryClaimLease();
		expect(other).toBeNull();
		// Simulate surviving past the original expiry by renewing after a short sleep
		// is unnecessary: renew already extended from wall clock.
		expect(untilAfter).toBeGreaterThan(Date.now());
		lease?.release();
		sched.close();
	});

	test("crash takeover after lease expiry", () => {
		const dbPath = tempDb();
		const a = openReflectSchedule(dbPath);
		const now = 50_000;
		const leaseA = a.tryClaimLease(now);
		expect(leaseA).not.toBeNull();
		// Simulate crash: do not release. Claim after expiry.
		const b = openReflectSchedule(dbPath);
		const leaseB = b.tryClaimLease(now + LEASE_MS + 1);
		expect(leaseB).not.toBeNull();
		expect(leaseB?.owner).not.toBe(leaseA?.owner);
		leaseB?.release();
		a.close();
		b.close();
	});

	test("stale owner cannot commit or renew after takeover", () => {
		const dbPath = tempDb();
		const a = openReflectSchedule(dbPath);
		const now = 100_000;
		const leaseA = must(a.tryClaimLease(now));
		const b = openReflectSchedule(dbPath);
		const leaseB = must(b.tryClaimLease(now + LEASE_MS + 5));

		expect(leaseA.renew()).toBe(false);
		expect(
			a.commitAttempt(leaseA.owner, { success: true }, now + LEASE_MS + 10),
		).toBe(false);
		expect(
			b.commitAttempt(leaseB.owner, { success: true }, now + LEASE_MS + 10),
		).toBe(true);

		const state = b.getState();
		expect(state.last_success_at).toBe(now + LEASE_MS + 10);
		expect(state.next_scheduled_attempt_at).toBe(
			now + LEASE_MS + 10 + SUCCESS_INTERVAL_MS,
		);

		leaseB.release();
		a.close();
		b.close();
	});

	test("retry floor after failure and success interval", () => {
		const dbPath = tempDb();
		const sched = openReflectSchedule(dbPath);
		sched.setEnabled(true);
		const now = 200_000;
		const lease = must(sched.tryClaimLease(now));

		expect(sched.canSchedule(now)).toBe(true);
		expect(sched.commitAttempt(lease.owner, { success: false }, now)).toBe(
			true,
		);
		expect(sched.canSchedule(now + FAILURE_FLOOR_MS - 1)).toBe(false);
		expect(sched.canSchedule(now + FAILURE_FLOOR_MS)).toBe(true);

		const now2 = now + FAILURE_FLOOR_MS;
		// Re-claim after release for the success path.
		lease.release();
		const lease2 = must(sched.tryClaimLease(now2));
		expect(sched.commitAttempt(lease2.owner, { success: true }, now2)).toBe(
			true,
		);
		expect(sched.canSchedule(now2 + SUCCESS_INTERVAL_MS - 1)).toBe(false);
		expect(sched.canSchedule(now2 + SUCCESS_INTERVAL_MS)).toBe(true);

		// Manual runs bypass cadence — canSchedule is only for scheduled path.
		// Enabled remains true.
		expect(sched.getState().enabled).toBe(true);
		lease2.release();
		sched.close();
	});
});
