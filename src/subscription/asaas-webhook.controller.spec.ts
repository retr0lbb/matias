import { Logger, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MockedFunction, MockInstance } from "vitest";
import { PaymentService } from "../payment/payment.service.js";
import { AsaasWebhookController } from "./asaas-webhook.controller.js";
import { SubscriptionService } from "./subscription.service.js";

// Tests marked with "GAP:" describe behavior the webhook should have but does
// not have yet. They are expected to fail until the source is fixed.

const TOKEN = "fake-webhook-token-0123456789abcdef";
const SUBSCRIPTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const createPaymentServiceMock = () => ({
	isValidWebhookToken: vi.fn() as unknown as MockedFunction<PaymentService["isValidWebhookToken"]>,
});

const createSubscriptionServiceMock = () => ({
	activateFromPayment: vi.fn() as unknown as MockedFunction<
		SubscriptionService["activateFromPayment"]
	>,
});

/** A payment event shaped like the ones Asaas sends, with fields we ignore. */
const buildEvent = (event: string, payment: Record<string, unknown> | null = {}) => ({
	id: "evt_fake_1",
	event,
	dateCreated: "2026-11-13 12:00:00",
	account: { id: "acc_fake_1", ownerId: null },
	...(payment
		? {
				payment: {
					object: "payment",
					id: "pay_fake_1",
					customer: "cus_fake_1",
					subscription: "sub_fake_1",
					externalReference: SUBSCRIPTION_ID,
					status: "RECEIVED",
					billingType: "PIX",
					value: 29.9,
					...payment,
				},
			}
		: {}),
});

describe("AsaasWebhookController", () => {
	let controller: AsaasWebhookController;
	let paymentService: ReturnType<typeof createPaymentServiceMock>;
	let subscriptionService: ReturnType<typeof createSubscriptionServiceMock>;
	let infoLog: MockInstance<Logger["log"]>;
	let warnLog: MockInstance<Logger["warn"]>;

	beforeEach(async () => {
		paymentService = createPaymentServiceMock();
		subscriptionService = createSubscriptionServiceMock();
		paymentService.isValidWebhookToken.mockReturnValue(true);
		subscriptionService.activateFromPayment.mockResolvedValue(true);

		const module = await Test.createTestingModule({
			controllers: [AsaasWebhookController],
			providers: [
				{ provide: PaymentService, useValue: paymentService },
				{ provide: SubscriptionService, useValue: subscriptionService },
			],
		}).compile();

		controller = module.get(AsaasWebhookController);

		infoLog = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
		warnLog = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe("handle", () => {
		describe("authentication", () => {
			it("should validate the token received in the header", async () => {
				await controller.handle(TOKEN, buildEvent("PAYMENT_RECEIVED"));

				expect(paymentService.isValidWebhookToken).toHaveBeenCalledTimes(1);
				expect(paymentService.isValidWebhookToken).toHaveBeenCalledWith(TOKEN);
			});

			it.each([
				["is wrong", "wrong-token"],
				["is empty", ""],
				["is missing", undefined],
			])("should throw UnauthorizedException when the token %s", async (_label, token) => {
				paymentService.isValidWebhookToken.mockReturnValue(false);

				await expect(controller.handle(token, buildEvent("PAYMENT_RECEIVED"))).rejects.toThrow(
					UnauthorizedException,
				);
			});

			it("should not activate anything when the token is invalid", async () => {
				paymentService.isValidWebhookToken.mockReturnValue(false);

				await expect(
					controller.handle("wrong-token", buildEvent("PAYMENT_RECEIVED")),
				).rejects.toThrow();

				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
			});

			it("should reject an invalid token even when the body is malformed", async () => {
				paymentService.isValidWebhookToken.mockReturnValue(false);

				await expect(controller.handle("wrong-token", null)).rejects.toThrow(UnauthorizedException);
			});

			it("should check the token before reading the body", async () => {
				paymentService.isValidWebhookToken.mockReturnValue(false);
				const body = new Proxy(
					{},
					{
						get: () => {
							throw new Error("body was read before the token was checked");
						},
					},
				);

				await expect(controller.handle("wrong-token", body)).rejects.toThrow(UnauthorizedException);
			});
		});

		describe("paid events", () => {
			it.each(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"])(
				"should activate the subscription referenced by the payment on %s",
				async (event) => {
					const result = await controller.handle(TOKEN, buildEvent(event));

					expect(subscriptionService.activateFromPayment).toHaveBeenCalledTimes(1);
					expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(SUBSCRIPTION_ID);
					expect(result).toEqual({ received: true });
				},
			);

			it.each(["CREDIT_CARD", "PIX"])(
				"should activate regardless of the %s billing type",
				async (billingType) => {
					await controller.handle(TOKEN, buildEvent("PAYMENT_CONFIRMED", { billingType }));

					expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(SUBSCRIPTION_ID);
				},
			);

			it("should acknowledge the event when there was nothing to activate", async () => {
				subscriptionService.activateFromPayment.mockResolvedValue(false);

				await expect(controller.handle(TOKEN, buildEvent("PAYMENT_RECEIVED"))).resolves.toEqual({
					received: true,
				});
			});

			it.each([
				["null", null],
				["undefined", undefined],
			])("should pass a %s external reference on to the service", async (_label, reference) => {
				await controller.handle(
					TOKEN,
					buildEvent("PAYMENT_RECEIVED", { externalReference: reference }),
				);

				expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(reference);
			});

			it("should pass a reference that is not ours on to the service untouched", async () => {
				await controller.handle(
					TOKEN,
					buildEvent("PAYMENT_RECEIVED", { externalReference: "056984" }),
				);

				expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith("056984");
			});

			it("should ignore fields Asaas adds to the event", async () => {
				const event = { ...buildEvent("PAYMENT_RECEIVED", { brandNewField: { nested: 1 } }), extra: [] };

				await expect(controller.handle(TOKEN, event)).resolves.toEqual({ received: true });
				expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(SUBSCRIPTION_ID);
			});

			it("should fail the delivery when the activation fails, so Asaas retries it", async () => {
				const failure = new Error("connection terminated");
				subscriptionService.activateFromPayment.mockRejectedValue(failure);

				await expect(controller.handle(TOKEN, buildEvent("PAYMENT_RECEIVED"))).rejects.toBe(failure);
			});

			it("should acknowledge both deliveries when the same event arrives twice", async () => {
				subscriptionService.activateFromPayment
					.mockResolvedValueOnce(true)
					.mockResolvedValueOnce(false);
				const event = buildEvent("PAYMENT_RECEIVED");

				const results = await Promise.all([
					controller.handle(TOKEN, event),
					controller.handle(TOKEN, event),
				]);

				expect(results).toEqual([{ received: true }, { received: true }]);
				expect(subscriptionService.activateFromPayment).toHaveBeenCalledTimes(2);
			});

			it("should acknowledge CONFIRMED and RECEIVED of the same payment arriving together", async () => {
				subscriptionService.activateFromPayment
					.mockResolvedValueOnce(true)
					.mockResolvedValueOnce(false);

				const results = await Promise.all([
					controller.handle(TOKEN, buildEvent("PAYMENT_CONFIRMED")),
					controller.handle(TOKEN, buildEvent("PAYMENT_RECEIVED")),
				]);

				expect(results).toEqual([{ received: true }, { received: true }]);
			});

			it("should log the outcome without the token", async () => {
				await controller.handle(TOKEN, buildEvent("PAYMENT_RECEIVED"));

				const logged = infoLog.mock.calls.map((call) => call.join(" ")).join("\n");
				expect(logged).toContain("pay_fake_1");
				expect(logged).not.toContain(TOKEN);
			});

			// GAP: a paid event whose payment has no `id` fails the schema and is
			// dropped, even though the external reference needed to activate the
			// subscription is right there.
			it("should activate the subscription when the paid payment has no id", async () => {
				await controller.handle(TOKEN, buildEvent("PAYMENT_RECEIVED", { id: undefined }));

				expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(SUBSCRIPTION_ID);
			});

			// GAP: the Asaas subscription id is stored locally, but the webhook only
			// trusts externalReference. A payment that arrives without it (edited on
			// the Asaas panel, for instance) can never activate the subscription.
			it("should fall back to the Asaas subscription id when the payment has no external reference", async () => {
				subscriptionService.activateFromPayment.mockResolvedValue(false);

				await controller.handle(
					TOKEN,
					buildEvent("PAYMENT_RECEIVED", { externalReference: null }),
				);

				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalledWith(null);
			});
		});

		describe("ignored events", () => {
			it.each([
				"PAYMENT_CREATED",
				"PAYMENT_UPDATED",
				"PAYMENT_AUTHORIZED",
				"PAYMENT_AWAITING_RISK_ANALYSIS",
				"PAYMENT_BANK_SLIP_VIEWED",
				"PAYMENT_CHECKOUT_VIEWED",
				"SUBSCRIPTION_CREATED",
				"SUBSCRIPTION_UPDATED",
				"payment_received",
				"PAYMENT_RECEIVED ",
				"",
			])("should acknowledge '%s' without activating anything", async (event) => {
				await expect(controller.handle(TOKEN, buildEvent(event))).resolves.toEqual({
					received: true,
				});
				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
			});

			it("should acknowledge a paid event that carries no payment", async () => {
				await expect(
					controller.handle(TOKEN, buildEvent("PAYMENT_RECEIVED", null)),
				).resolves.toEqual({ received: true });
				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
			});

			// GAP: money going back or a subscription ending never reaches the
			// service, so the user keeps the paid plan forever. These events are
			// acknowledged and dropped.
			it.each([
				"PAYMENT_REFUNDED",
				"PAYMENT_CHARGEBACK_REQUESTED",
				"PAYMENT_OVERDUE",
				"PAYMENT_DELETED",
				"PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
				"SUBSCRIPTION_INACTIVATED",
				"SUBSCRIPTION_DELETED",
			])("should not silently drop '%s'", async (event) => {
				await controller.handle(TOKEN, buildEvent(event));

				const handled =
					subscriptionService.activateFromPayment.mock.calls.length > 0 ||
					warnLog.mock.calls.length > 0;
				expect(handled).toBe(true);
			});
		});

		describe("malformed bodies", () => {
			it.each([
				["null", null],
				["undefined", undefined],
				["an empty object", {}],
				["a string", "PAYMENT_RECEIVED"],
				["a number", 42],
				["an array", [buildEvent("PAYMENT_RECEIVED")]],
				["an event that is not a string", { event: 123, payment: { id: "pay_fake_1" } }],
				["an event that is null", { event: null }],
				["a payment that is a string", { event: "PAYMENT_RECEIVED", payment: "pay_fake_1" }],
				["a payment that is null", { event: "PAYMENT_RECEIVED", payment: null }],
				["a payment that is an array", { event: "PAYMENT_RECEIVED", payment: [] }],
				[
					"an external reference that is a number",
					{ event: "PAYMENT_RECEIVED", payment: { id: "pay_fake_1", externalReference: 56984 } },
				],
				[
					"an external reference that is an object",
					{ event: "PAYMENT_RECEIVED", payment: { id: "pay_fake_1", externalReference: {} } },
				],
			])("should acknowledge and ignore a body that is %s", async (_label, body) => {
				await expect(controller.handle(TOKEN, body)).resolves.toEqual({ received: true });
				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
			});

			it("should warn when the body is malformed", async () => {
				await controller.handle(TOKEN, {});

				expect(warnLog).toHaveBeenCalledTimes(1);
			});

			it("should not warn when the body is a well formed event it does not handle", async () => {
				await controller.handle(TOKEN, buildEvent("PAYMENT_CREATED"));

				expect(warnLog).not.toHaveBeenCalled();
			});
		});
	});
});
