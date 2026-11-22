import { BadGatewayException, Logger } from "@nestjs/common";
import { getDrizzleToken } from "@nestjs/drizzle";
import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { MockedFunction, MockInstance } from "vitest";
import { PaymentService } from "../../../payment/payment.service.js";
import { SubscriptionService } from "../../../subscription/subscription.service.js";
import {
	BELIARGE_REASON,
	type DelinquentSubscription,
	graceCutoff,
	MrBeliargeService,
} from "./beliarge.service.js";

// 2026-11-22 12:00 in São Paulo (UTC-3).
const NOW = new Date("2026-11-22T15:00:00.000Z");
const SUBSCRIPTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_SUBSCRIPTION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const dialect = new PgDialect();

/** SQL text and bound values of a Drizzle condition. */
const compile = (condition: SQL | undefined) => {
	if (!condition) throw new Error("expected a SQL condition, got undefined");
	return dialect.sqlToQuery(condition);
};

/** Fake Drizzle client for `select().from().innerJoin().where().groupBy().having()`. */
const createDbMock = () => {
	const chain = {
		from: vi.fn<(table: unknown) => unknown>(),
		innerJoin: vi.fn<(table: unknown, on: SQL) => unknown>(),
		where: vi.fn<(condition: SQL | undefined) => unknown>(),
		groupBy: vi.fn<(column: unknown) => unknown>(),
		having: vi.fn<(condition: SQL) => Promise<DelinquentSubscription[]>>(),
	};
	chain.from.mockReturnValue(chain);
	chain.innerJoin.mockReturnValue(chain);
	chain.where.mockReturnValue(chain);
	chain.groupBy.mockReturnValue(chain);
	chain.having.mockResolvedValue([]);

	return { select: vi.fn<(fields: unknown) => unknown>(() => chain), chain };
};

const createPaymentServiceMock = () => ({
	deactivateSubscription: vi.fn() as unknown as MockedFunction<
		PaymentService["deactivateSubscription"]
	>,
});

const createSubscriptionServiceMock = () => ({
	deactivate: vi.fn() as unknown as MockedFunction<SubscriptionService["deactivate"]>,
});

const buildDelinquent = (
	overrides: Partial<DelinquentSubscription> = {},
): DelinquentSubscription => ({
	id: SUBSCRIPTION_ID,
	asaasSubscriptionId: "sub_fake_1",
	oldestOverdueDueDate: "2026-11-10",
	...overrides,
});

describe("graceCutoff", () => {
	it.each([
		["midday", "2026-11-22T15:00:00.000Z", "2026-11-19"],
		["just after midnight in São Paulo", "2026-11-22T03:00:00.000Z", "2026-11-19"],
		["late evening in São Paulo, already the next day in UTC", "2026-11-23T02:59:59.000Z", "2026-11-19"],
		["the start of a month", "2026-12-02T15:00:00.000Z", "2026-11-29"],
		["the start of a year", "2027-01-01T15:00:00.000Z", "2026-12-29"],
	])("should return three days before today when it is %s", (_label, now, expected) => {
		expect(graceCutoff(new Date(now))).toBe(expected);
	});
});

describe("MrBeliargeService", () => {
	let service: MrBeliargeService;
	let db: ReturnType<typeof createDbMock>;
	let paymentService: ReturnType<typeof createPaymentServiceMock>;
	let subscriptionService: ReturnType<typeof createSubscriptionServiceMock>;
	let warnLog: MockInstance<Logger["warn"]>;
	let errorLog: MockInstance<Logger["error"]>;

	beforeEach(async () => {
		db = createDbMock();
		paymentService = createPaymentServiceMock();
		subscriptionService = createSubscriptionServiceMock();
		warnLog = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
		errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

		const module = await Test.createTestingModule({
			providers: [
				MrBeliargeService,
				{ provide: getDrizzleToken(), useValue: db },
				{ provide: PaymentService, useValue: paymentService },
				{ provide: SubscriptionService, useValue: subscriptionService },
			],
		}).compile();

		service = module.get(MrBeliargeService);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe("findDelinquent", () => {
		it("should return the rows of the query when there are delinquent subscriptions", async () => {
			const rows = [buildDelinquent()];
			db.chain.having.mockResolvedValue(rows);

			await expect(service.findDelinquent(NOW)).resolves.toBe(rows);
		});

		it("should return an empty array when no subscription is delinquent", async () => {
			await expect(service.findDelinquent(NOW)).resolves.toEqual([]);
		});

		it("should only look at live subscriptions with an OVERDUE charge", async () => {
			await service.findDelinquent(NOW);

			const where = compile(db.chain.where.mock.calls[0]?.[0]);
			expect(where.sql).toContain('"subscriptions"."status" in');
			expect(where.sql).toContain('"payments"."status" =');
			expect(where.params).toEqual(["ACTIVE", "EXPIRED", "OVERDUE"]);
		});

		it("should join payments on the subscription id", async () => {
			await service.findDelinquent(NOW);

			const on = compile(db.chain.innerJoin.mock.calls[0]?.[1]);
			expect(on.sql).toBe('"payments"."subscription_id" = "subscriptions"."id"');
		});

		it("should keep only subscriptions whose oldest overdue charge is before the grace cutoff", async () => {
			await service.findDelinquent(NOW);

			const having = compile(db.chain.having.mock.calls[0]?.[0]);
			expect(having.sql).toBe('min("payments"."due_date") < $1');
			expect(having.params).toEqual(["2026-11-19"]);
		});

		it("should propagate the error when the query fails", async () => {
			db.chain.having.mockRejectedValue(new Error("connection lost"));

			await expect(service.findDelinquent(NOW)).rejects.toThrow("connection lost");
		});
	});

	describe("run", () => {
		it("should return an empty summary when no subscription is delinquent", async () => {
			const summary = await service.run(NOW);

			expect(summary).toEqual({ checked: 0, deactivated: 0, failed: 0 });
			expect(paymentService.deactivateSubscription).not.toHaveBeenCalled();
			expect(subscriptionService.deactivate).not.toHaveBeenCalled();
		});

		it("should deactivate on Asaas and then locally when the subscription is delinquent", async () => {
			db.chain.having.mockResolvedValue([buildDelinquent()]);
			subscriptionService.deactivate.mockResolvedValue(true);

			const summary = await service.run(NOW);

			expect(summary).toEqual({ checked: 1, deactivated: 1, failed: 0 });
			expect(paymentService.deactivateSubscription).toHaveBeenCalledWith("sub_fake_1");
			expect(subscriptionService.deactivate).toHaveBeenCalledWith(
				SUBSCRIPTION_ID,
				"sub_fake_1",
				BELIARGE_REASON,
			);
			expect(
				paymentService.deactivateSubscription.mock.invocationCallOrder[0],
			).toBeLessThan(subscriptionService.deactivate.mock.invocationCallOrder[0] ?? 0);
			expect(warnLog.mock.calls[0]?.join(" ")).toContain("2026-11-10");
		});

		it("should only deactivate locally when the subscription has no Asaas id", async () => {
			db.chain.having.mockResolvedValue([buildDelinquent({ asaasSubscriptionId: null })]);
			subscriptionService.deactivate.mockResolvedValue(true);

			const summary = await service.run(NOW);

			expect(summary).toEqual({ checked: 1, deactivated: 1, failed: 0 });
			expect(paymentService.deactivateSubscription).not.toHaveBeenCalled();
			expect(subscriptionService.deactivate).toHaveBeenCalledWith(
				SUBSCRIPTION_ID,
				null,
				BELIARGE_REASON,
			);
		});

		it("should not count the subscription when it was already ended locally", async () => {
			db.chain.having.mockResolvedValue([buildDelinquent()]);
			subscriptionService.deactivate.mockResolvedValue(false);

			const summary = await service.run(NOW);

			expect(summary).toEqual({ checked: 1, deactivated: 0, failed: 0 });
			expect(warnLog).not.toHaveBeenCalled();
		});

		it("should skip the local deactivation when Asaas fails", async () => {
			db.chain.having.mockResolvedValue([buildDelinquent()]);
			paymentService.deactivateSubscription.mockRejectedValue(
				new BadGatewayException("Payment provider error"),
			);

			const summary = await service.run(NOW);

			expect(summary).toEqual({ checked: 1, deactivated: 0, failed: 1 });
			expect(subscriptionService.deactivate).not.toHaveBeenCalled();
			expect(errorLog.mock.calls[0]?.join(" ")).toContain(SUBSCRIPTION_ID);
			expect(errorLog.mock.calls[0]?.join(" ")).toContain("Payment provider error");
		});

		it("should count a failure when the local deactivation throws", async () => {
			db.chain.having.mockResolvedValue([buildDelinquent()]);
			subscriptionService.deactivate.mockRejectedValue("db down");

			const summary = await service.run(NOW);

			expect(summary).toEqual({ checked: 1, deactivated: 0, failed: 1 });
			expect(errorLog.mock.calls[0]?.join(" ")).toContain("db down");
		});

		it("should keep going with the next subscription when one fails", async () => {
			db.chain.having.mockResolvedValue([
				buildDelinquent(),
				buildDelinquent({ id: OTHER_SUBSCRIPTION_ID, asaasSubscriptionId: "sub_fake_2" }),
			]);
			paymentService.deactivateSubscription
				.mockRejectedValueOnce(new Error("timeout"))
				.mockResolvedValueOnce({} as Awaited<ReturnType<PaymentService["deactivateSubscription"]>>);
			subscriptionService.deactivate.mockResolvedValue(true);

			const summary = await service.run(NOW);

			expect(summary).toEqual({ checked: 2, deactivated: 1, failed: 1 });
			expect(subscriptionService.deactivate).toHaveBeenCalledTimes(1);
			expect(subscriptionService.deactivate).toHaveBeenCalledWith(
				OTHER_SUBSCRIPTION_ID,
				"sub_fake_2",
				BELIARGE_REASON,
			);
		});

		it("should use the current time when no date is given", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);

			await service.run();

			expect(compile(db.chain.having.mock.calls[0]?.[0]).params).toEqual(["2026-11-19"]);
			vi.useRealTimers();
		});

		it("should propagate the error when the query fails", async () => {
			db.chain.having.mockRejectedValue(new Error("connection lost"));

			await expect(service.run(NOW)).rejects.toThrow("connection lost");
		});
	});
});
