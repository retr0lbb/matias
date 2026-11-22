import { BadGatewayException, Logger } from "@nestjs/common";
import { getDrizzleToken } from "@nestjs/drizzle";
import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { MockedFunction, MockInstance } from "vitest";
import type { AsaasPayment, AsaasSubscription } from "../../../payment/dto/asaas-subscription.dto.js";
import { PaymentService } from "../../../payment/payment.service.js";
import { PaymentRecordService } from "../../../subscription/payment-record.service.js";
import { SubscriptionService } from "../../../subscription/subscription.service.js";
import {
	CountOlafService,
	type LiveSubscription,
	NOT_ON_ASAAS_REASON,
	ORPHAN_AFTER_MS,
} from "./olaf.service.js";

const NOW = new Date("2026-11-22T15:00:00.000Z");
const SUBSCRIPTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_SUBSCRIPTION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ASAAS_ID = "sub_fake_1";

const dialect = new PgDialect();

const compile = (condition: SQL | undefined) => {
	if (!condition) throw new Error("expected a SQL condition, got undefined");
	return dialect.sqlToQuery(condition);
};

/** Fake Drizzle client for `select().from().where()`. */
const createDbMock = () => {
	const chain = {
		from: vi.fn<(table: unknown) => unknown>(),
		where: vi.fn<(condition: SQL | undefined) => Promise<LiveSubscription[]>>(),
	};
	chain.from.mockReturnValue(chain);
	chain.where.mockResolvedValue([]);

	return { select: vi.fn<(fields: unknown) => unknown>(() => chain), chain };
};

const createPaymentServiceMock = () => ({
	findSubscription: vi.fn() as unknown as MockedFunction<PaymentService["findSubscription"]>,
	listSubscriptionPayments: vi.fn() as unknown as MockedFunction<
		PaymentService["listSubscriptionPayments"]
	>,
});

const createSubscriptionServiceMock = () => ({
	deactivate: vi.fn() as unknown as MockedFunction<SubscriptionService["deactivate"]>,
	activateFromPayment: vi.fn() as unknown as MockedFunction<
		SubscriptionService["activateFromPayment"]
	>,
	endDiscountIfExhausted: vi.fn() as unknown as MockedFunction<
		SubscriptionService["endDiscountIfExhausted"]
	>,
});

const createPaymentRecordsMock = () => ({
	recordFromWebhook: vi.fn() as unknown as MockedFunction<
		PaymentRecordService["recordFromWebhook"]
	>,
});

const buildLocal = (overrides: Partial<LiveSubscription> = {}): LiveSubscription => ({
	id: SUBSCRIPTION_ID,
	status: "ACTIVE",
	asaasSubscriptionId: ASAAS_ID,
	subscribedAt: new Date("2026-10-01T12:00:00.000Z"),
	...overrides,
});

const buildRemote = (overrides: Partial<AsaasSubscription> = {}): AsaasSubscription => ({
	object: "subscription",
	id: ASAAS_ID,
	dateCreated: "2026-10-01",
	customer: "cus_fake_1",
	billingType: "PIX",
	cycle: "MONTHLY",
	value: 29.9,
	nextDueDate: "2026-12-01",
	status: "ACTIVE",
	deleted: false,
	...overrides,
});

const buildCharge = (overrides: Partial<AsaasPayment> = {}): AsaasPayment => ({
	object: "payment",
	id: "pay_fake_1",
	customer: "cus_fake_1",
	subscription: ASAAS_ID,
	externalReference: SUBSCRIPTION_ID,
	status: "PENDING",
	billingType: "PIX",
	value: 29.9,
	dueDate: "2026-11-01",
	invoiceUrl: "https://sandbox.asaas.example/i/fake_1",
	...overrides,
});

describe("CountOlafService", () => {
	let service: CountOlafService;
	let db: ReturnType<typeof createDbMock>;
	let paymentService: ReturnType<typeof createPaymentServiceMock>;
	let subscriptionService: ReturnType<typeof createSubscriptionServiceMock>;
	let paymentRecords: ReturnType<typeof createPaymentRecordsMock>;
	let warnLog: MockInstance<Logger["warn"]>;
	let errorLog: MockInstance<Logger["error"]>;

	/** Makes `findLive` return these rows. */
	const givenLocal = (...rows: LiveSubscription[]) => db.chain.where.mockResolvedValue(rows);

	beforeEach(async () => {
		db = createDbMock();
		paymentService = createPaymentServiceMock();
		subscriptionService = createSubscriptionServiceMock();
		paymentRecords = createPaymentRecordsMock();
		warnLog = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
		errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

		paymentService.findSubscription.mockResolvedValue(buildRemote());
		paymentService.listSubscriptionPayments.mockResolvedValue([]);
		subscriptionService.deactivate.mockResolvedValue(true);
		subscriptionService.activateFromPayment.mockResolvedValue(true);
		subscriptionService.endDiscountIfExhausted.mockResolvedValue(false);
		paymentRecords.recordFromWebhook.mockResolvedValue(true);

		const module = await Test.createTestingModule({
			providers: [
				CountOlafService,
				{ provide: getDrizzleToken(), useValue: db },
				{ provide: PaymentService, useValue: paymentService },
				{ provide: SubscriptionService, useValue: subscriptionService },
				{ provide: PaymentRecordService, useValue: paymentRecords },
			],
		}).compile();

		service = module.get(CountOlafService);
		warnLog.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe("findLive", () => {
		it("should return the live subscriptions when the query succeeds", async () => {
			const rows = [buildLocal()];
			givenLocal(...rows);

			await expect(service.findLive()).resolves.toEqual(rows);
		});

		it("should filter on the PENDING, ACTIVE and EXPIRED statuses", async () => {
			await service.findLive();

			const where = compile(db.chain.where.mock.calls[0]?.[0]);
			expect(where.sql).toContain('"subscriptions"."status" in');
			expect(where.params).toEqual(["PENDING", "ACTIVE", "EXPIRED"]);
		});

		it("should propagate the error when the query fails", async () => {
			db.chain.where.mockRejectedValue(new Error("connection lost"));

			await expect(service.findLive()).rejects.toThrow("connection lost");
		});
	});

	describe("run", () => {
		it("should return an empty summary when there is no live subscription", async () => {
			const summary = await service.run(NOW);

			expect(summary).toEqual({
				checked: 0,
				activated: 0,
				deactivated: 0,
				chargesWritten: 0,
				failed: 0,
			});
			expect(paymentService.findSubscription).not.toHaveBeenCalled();
		});

		it("should propagate the error when loading the subscriptions fails", async () => {
			db.chain.where.mockRejectedValue(new Error("connection lost"));

			await expect(service.run(NOW)).rejects.toThrow("connection lost");
		});

		describe("without an Asaas subscription id", () => {
			it("should deactivate a PENDING subscription older than the orphan threshold", async () => {
				givenLocal(
					buildLocal({
						status: "PENDING",
						asaasSubscriptionId: null,
						subscribedAt: new Date(NOW.getTime() - ORPHAN_AFTER_MS - 1),
					}),
				);

				const summary = await service.run(NOW);

				expect(subscriptionService.deactivate).toHaveBeenCalledWith(
					SUBSCRIPTION_ID,
					null,
					NOT_ON_ASAAS_REASON,
				);
				expect(summary.deactivated).toBe(1);
				expect(paymentService.findSubscription).not.toHaveBeenCalled();
			});

			it.each([
				["exactly at the threshold", 0],
				["younger than the threshold", 1000],
			])("should skip a PENDING subscription %s", async (_label, youngerBy) => {
				givenLocal(
					buildLocal({
						status: "PENDING",
						asaasSubscriptionId: null,
						subscribedAt: new Date(NOW.getTime() - ORPHAN_AFTER_MS + youngerBy),
					}),
				);

				const summary = await service.run(NOW);

				expect(subscriptionService.deactivate).not.toHaveBeenCalled();
				expect(summary.deactivated).toBe(0);
			});

			it("should skip a PENDING subscription with no subscribedAt", async () => {
				givenLocal(buildLocal({ status: "PENDING", asaasSubscriptionId: null, subscribedAt: null }));

				await service.run(NOW);

				expect(subscriptionService.deactivate).not.toHaveBeenCalled();
			});

			it.each(["ACTIVE", "EXPIRED"] as const)(
				"should skip a %s subscription",
				async (status) => {
					givenLocal(buildLocal({ status, asaasSubscriptionId: null }));

					await service.run(NOW);

					expect(subscriptionService.deactivate).not.toHaveBeenCalled();
					expect(paymentService.findSubscription).not.toHaveBeenCalled();
				},
			);
		});

		describe("when the subscription is gone or ended on Asaas", () => {
			it("should deactivate the subscription when Asaas does not find it", async () => {
				givenLocal(buildLocal());
				paymentService.findSubscription.mockResolvedValue(null);

				const summary = await service.run(NOW);

				expect(paymentService.findSubscription).toHaveBeenCalledWith(ASAAS_ID);
				expect(subscriptionService.deactivate).toHaveBeenCalledWith(
					SUBSCRIPTION_ID,
					ASAAS_ID,
					NOT_ON_ASAAS_REASON,
				);
				expect(summary.deactivated).toBe(1);
				expect(paymentService.listSubscriptionPayments).not.toHaveBeenCalled();
			});

			it("should deactivate the subscription when Asaas marks it deleted", async () => {
				givenLocal(buildLocal());
				paymentService.findSubscription.mockResolvedValue(buildRemote({ deleted: true }));

				await service.run(NOW);

				expect(subscriptionService.deactivate).toHaveBeenCalledWith(
					SUBSCRIPTION_ID,
					ASAAS_ID,
					NOT_ON_ASAAS_REASON,
				);
			});

			it.each(["INACTIVE", "EXPIRED"] as const)(
				"should deactivate the subscription when Asaas says %s",
				async (status) => {
					givenLocal(buildLocal());
					paymentService.findSubscription.mockResolvedValue(buildRemote({ status }));

					const summary = await service.run(NOW);

					expect(subscriptionService.deactivate).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						ASAAS_ID,
						`OLAF_ASAAS_${status}`,
					);
					expect(summary.deactivated).toBe(1);
					expect(paymentService.listSubscriptionPayments).not.toHaveBeenCalled();
					expect(warnLog.mock.calls[0]?.join(" ")).toContain(`OLAF_ASAAS_${status}`);
				},
			);

			it("should not count the subscription when it was already ended locally", async () => {
				givenLocal(buildLocal());
				paymentService.findSubscription.mockResolvedValue(null);
				subscriptionService.deactivate.mockResolvedValue(false);

				const summary = await service.run(NOW);

				expect(summary.deactivated).toBe(0);
				expect(warnLog).not.toHaveBeenCalled();
			});
		});

		describe("when the subscription is ACTIVE on Asaas", () => {
			it.each([
				["PENDING", "PAYMENT_CREATED"],
				["CONFIRMED", "PAYMENT_CONFIRMED"],
				["RECEIVED", "PAYMENT_RECEIVED"],
				["RECEIVED_IN_CASH", "PAYMENT_RECEIVED"],
				["OVERDUE", "PAYMENT_OVERDUE"],
				["REFUNDED", "PAYMENT_REFUNDED"],
				["CHARGEBACK_REQUESTED", "PAYMENT_CHARGEBACK_REQUESTED"],
			])("should record a %s charge as %s", async (status, event) => {
				givenLocal(buildLocal());
				paymentService.listSubscriptionPayments.mockResolvedValue([buildCharge({ status })]);

				const summary = await service.run(NOW);

				expect(paymentRecords.recordFromWebhook).toHaveBeenCalledWith(
					event,
					expect.objectContaining({ id: "pay_fake_1", status }),
				);
				expect(summary.chargesWritten).toBe(1);
			});

			it.each(["AWAITING_RISK_ANALYSIS", "DUNNING_REQUESTED", "", "toString"])(
				"should ignore a charge with the untracked status %j",
				async (status) => {
					givenLocal(buildLocal());
					paymentService.listSubscriptionPayments.mockResolvedValue([buildCharge({ status })]);

					const summary = await service.run(NOW);

					expect(paymentRecords.recordFromWebhook).not.toHaveBeenCalled();
					expect(summary.chargesWritten).toBe(0);
				},
			);

			it("should send our own ids with the charge when the Asaas reference differs", async () => {
				givenLocal(buildLocal());
				paymentService.listSubscriptionPayments.mockResolvedValue([
					buildCharge({ externalReference: "edited-on-panel", subscription: null }),
				]);

				await service.run(NOW);

				expect(paymentRecords.recordFromWebhook).toHaveBeenCalledWith(
					"PAYMENT_CREATED",
					expect.objectContaining({ externalReference: SUBSCRIPTION_ID, subscription: ASAAS_ID }),
				);
			});

			it("should not count a charge that was not written", async () => {
				givenLocal(buildLocal());
				paymentService.listSubscriptionPayments.mockResolvedValue([
					buildCharge({ id: "pay_1" }),
					buildCharge({ id: "pay_2" }),
				]);
				paymentRecords.recordFromWebhook.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

				const summary = await service.run(NOW);

				expect(paymentRecords.recordFromWebhook).toHaveBeenCalledTimes(2);
				expect(summary.chargesWritten).toBe(1);
			});

			it("should do nothing more when there are no charges", async () => {
				givenLocal(buildLocal({ status: "PENDING" }));

				const summary = await service.run(NOW);

				expect(paymentService.listSubscriptionPayments).toHaveBeenCalledWith(ASAAS_ID);
				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
				expect(subscriptionService.endDiscountIfExhausted).not.toHaveBeenCalled();
				expect(summary).toEqual({
					checked: 1,
					activated: 0,
					deactivated: 0,
					chargesWritten: 0,
					failed: 0,
				});
			});

			it("should not activate a PENDING subscription when no charge is paid", async () => {
				givenLocal(buildLocal({ status: "PENDING" }));
				paymentService.listSubscriptionPayments.mockResolvedValue([
					buildCharge({ status: "PENDING" }),
					buildCharge({ id: "pay_2", status: "OVERDUE" }),
				]);

				await service.run(NOW);

				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
				expect(subscriptionService.endDiscountIfExhausted).not.toHaveBeenCalled();
			});

			it.each(["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"])(
				"should activate a PENDING subscription when a charge is %s",
				async (status) => {
					givenLocal(buildLocal({ status: "PENDING" }));
					paymentService.listSubscriptionPayments.mockResolvedValue([buildCharge({ status })]);

					const summary = await service.run(NOW);

					expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						ASAAS_ID,
					);
					expect(subscriptionService.endDiscountIfExhausted).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						ASAAS_ID,
					);
					expect(summary.activated).toBe(1);
					expect(warnLog.mock.calls[0]?.join(" ")).toContain("activated");
				},
			);

			it("should store the charges before activating and ending the discount", async () => {
				givenLocal(buildLocal({ status: "PENDING" }));
				paymentService.listSubscriptionPayments.mockResolvedValue([
					buildCharge({ status: "RECEIVED" }),
				]);

				await service.run(NOW);

				const recorded = paymentRecords.recordFromWebhook.mock.invocationCallOrder[0] ?? 0;
				const activated = subscriptionService.activateFromPayment.mock.invocationCallOrder[0] ?? 0;
				const discount = subscriptionService.endDiscountIfExhausted.mock.invocationCallOrder[0] ?? 0;
				expect(recorded).toBeLessThan(activated);
				expect(activated).toBeLessThan(discount);
			});

			it("should not count the activation when the subscription was already activated", async () => {
				givenLocal(buildLocal({ status: "PENDING" }));
				paymentService.listSubscriptionPayments.mockResolvedValue([
					buildCharge({ status: "RECEIVED" }),
				]);
				subscriptionService.activateFromPayment.mockResolvedValue(false);

				const summary = await service.run(NOW);

				expect(summary.activated).toBe(0);
				expect(subscriptionService.endDiscountIfExhausted).toHaveBeenCalledTimes(1);
			});

			it.each(["ACTIVE", "EXPIRED"] as const)(
				"should only check the discount of a %s subscription with a paid charge",
				async (status) => {
					givenLocal(buildLocal({ status }));
					paymentService.listSubscriptionPayments.mockResolvedValue([
						buildCharge({ status: "RECEIVED" }),
					]);

					const summary = await service.run(NOW);

					expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
					expect(subscriptionService.endDiscountIfExhausted).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						ASAAS_ID,
					);
					expect(summary.activated).toBe(0);
				},
			);
		});

		describe("failures", () => {
			it("should count a failure and keep going when Asaas fails for one subscription", async () => {
				givenLocal(
					buildLocal(),
					buildLocal({ id: OTHER_SUBSCRIPTION_ID, asaasSubscriptionId: "sub_fake_2" }),
				);
				paymentService.findSubscription
					.mockRejectedValueOnce(new BadGatewayException("Payment provider error"))
					.mockResolvedValueOnce(null);

				const summary = await service.run(NOW);

				expect(summary.failed).toBe(1);
				expect(summary.deactivated).toBe(1);
				expect(subscriptionService.deactivate).toHaveBeenCalledWith(
					OTHER_SUBSCRIPTION_ID,
					"sub_fake_2",
					NOT_ON_ASAAS_REASON,
				);
				expect(errorLog.mock.calls[0]?.join(" ")).toContain(SUBSCRIPTION_ID);
				expect(errorLog.mock.calls[0]?.join(" ")).toContain("Payment provider error");
			});

			it("should count a failure when listing the charges fails", async () => {
				givenLocal(buildLocal());
				paymentService.listSubscriptionPayments.mockRejectedValue(new Error("timeout"));

				const summary = await service.run(NOW);

				expect(summary.failed).toBe(1);
				expect(paymentRecords.recordFromWebhook).not.toHaveBeenCalled();
			});

			it("should count a failure when recording a charge fails", async () => {
				givenLocal(buildLocal({ status: "PENDING" }));
				paymentService.listSubscriptionPayments.mockResolvedValue([
					buildCharge({ status: "RECEIVED" }),
				]);
				paymentRecords.recordFromWebhook.mockRejectedValue(new Error("db down"));

				const summary = await service.run(NOW);

				expect(summary.failed).toBe(1);
				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
			});

			it("should count a failure when ending the discount fails", async () => {
				givenLocal(buildLocal());
				paymentService.listSubscriptionPayments.mockResolvedValue([
					buildCharge({ status: "RECEIVED" }),
				]);
				subscriptionService.endDiscountIfExhausted.mockRejectedValue("asaas down");

				const summary = await service.run(NOW);

				expect(summary.failed).toBe(1);
				expect(errorLog.mock.calls[0]?.join(" ")).toContain("asaas down");
			});

			it("should count a failure when the local deactivation throws", async () => {
				givenLocal(buildLocal());
				paymentService.findSubscription.mockResolvedValue(null);
				subscriptionService.deactivate.mockRejectedValue(new Error("db down"));

				const summary = await service.run(NOW);

				expect(summary).toEqual({
					checked: 1,
					activated: 0,
					deactivated: 0,
					chargesWritten: 0,
					failed: 1,
				});
			});
		});

		it("should use the current time when no date is given", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			givenLocal(
				buildLocal({
					status: "PENDING",
					asaasSubscriptionId: null,
					subscribedAt: new Date(NOW.getTime() - ORPHAN_AFTER_MS - 1),
				}),
			);

			await service.run();

			expect(subscriptionService.deactivate).toHaveBeenCalledTimes(1);
			vi.useRealTimers();
		});
	});
});
