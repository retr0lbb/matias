import { Logger, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MockedFunction, MockInstance } from "vitest";
import { PaymentService } from "../../payment/payment.service.js";
import { SubscriptionService } from "../subscription.service.js";
import { AsaasWebhookController } from "./asaas-webhook.controller.js";

const TOKEN = "fake-webhook-token-0123456789abcdef";
const SUBSCRIPTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASAAS_SUBSCRIPTION_ID = "sub_fake_1";

const createPaymentServiceMock = () => ({
	isValidWebhookToken: vi.fn() as unknown as MockedFunction<PaymentService["isValidWebhookToken"]>,
});

const createSubscriptionServiceMock = () => ({
	activateFromPayment: vi.fn() as unknown as MockedFunction<
		SubscriptionService["activateFromPayment"]
	>,
	reactivatePastDue: vi.fn() as unknown as MockedFunction<SubscriptionService["reactivatePastDue"]>,
	markPastDue: vi.fn() as unknown as MockedFunction<SubscriptionService["markPastDue"]>,
	deactivate: vi.fn() as unknown as MockedFunction<SubscriptionService["deactivate"]>,
});

/** Request headers as Nest hands them over; no token means the header is absent. */
const headersWith = (token?: string): Record<string, string> => ({
	host: "fake-tunnel.ngrok-free.app",
	"content-type": "application/json",
	...(token === undefined ? {} : { "asaas-access-token": token }),
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
					subscription: ASAAS_SUBSCRIPTION_ID,
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
		subscriptionService.reactivatePastDue.mockResolvedValue(false);
		subscriptionService.markPastDue.mockResolvedValue(true);
		subscriptionService.deactivate.mockResolvedValue(true);

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
				await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED"));

				expect(paymentService.isValidWebhookToken).toHaveBeenCalledTimes(1);
				expect(paymentService.isValidWebhookToken).toHaveBeenCalledWith(TOKEN);
			});

			it("should take the token only from the asaas-access-token header", async () => {
				await controller.handle(
					{ authorization: `Bearer ${TOKEN}`, "access-token": TOKEN },
					buildEvent("PAYMENT_RECEIVED"),
				);

				expect(paymentService.isValidWebhookToken).toHaveBeenCalledWith(undefined);
			});

			it.each([
				["is wrong", "wrong-token"],
				["is empty", ""],
				["is missing", undefined],
			])("should throw UnauthorizedException when the token %s", async (_label, token) => {
				paymentService.isValidWebhookToken.mockReturnValue(false);

				await expect(
					controller.handle(headersWith(token), buildEvent("PAYMENT_RECEIVED")),
				).rejects.toThrow(UnauthorizedException);
			});

			it("should not activate anything when the token is invalid", async () => {
				paymentService.isValidWebhookToken.mockReturnValue(false);

				await expect(
					controller.handle(headersWith("wrong-token"), buildEvent("PAYMENT_RECEIVED")),
				).rejects.toThrow();

				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
			});

			it("should reject an invalid token even when the body is malformed", async () => {
				paymentService.isValidWebhookToken.mockReturnValue(false);

				await expect(controller.handle(headersWith("wrong-token"), null)).rejects.toThrow(
					UnauthorizedException,
				);
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

				await expect(controller.handle(headersWith("wrong-token"), body)).rejects.toThrow(
					UnauthorizedException,
				);
			});
		});

		describe("paid events", () => {
			it.each(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"])(
				"should activate the subscription referenced by the payment on %s",
				async (event) => {
					const result = await controller.handle(headersWith(TOKEN), buildEvent(event));

					expect(subscriptionService.activateFromPayment).toHaveBeenCalledTimes(1);
					expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						ASAAS_SUBSCRIPTION_ID,
					);
					expect(result).toEqual({ received: true });
				},
			);

			it.each(["CREDIT_CARD", "PIX"])(
				"should activate regardless of the %s billing type",
				async (billingType) => {
					await controller.handle(
						headersWith(TOKEN),
						buildEvent("PAYMENT_CONFIRMED", { billingType }),
					);

					expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						ASAAS_SUBSCRIPTION_ID,
					);
				},
			);

			it("should acknowledge the event when there was nothing to activate", async () => {
				subscriptionService.activateFromPayment.mockResolvedValue(false);

				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED")),
				).resolves.toEqual({
					received: true,
				});
			});

			it.each([
				["null", null],
				["undefined", undefined],
			])(
				"should send the Asaas subscription id as a fallback when the external reference is %s",
				async (_label, reference) => {
					await controller.handle(
						headersWith(TOKEN),
						buildEvent("PAYMENT_RECEIVED", { externalReference: reference }),
					);

					expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(
						undefined,
						ASAAS_SUBSCRIPTION_ID,
					);
				},
			);

			it.each([
				["null", null],
				["undefined", undefined],
			])(
				"should send no fallback when the Asaas subscription id of the payment is %s",
				async (_label, subscription) => {
					await controller.handle(
						headersWith(TOKEN),
						buildEvent("PAYMENT_RECEIVED", { subscription }),
					);

					expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						undefined,
					);
				},
			);

			it("should reactivate a past due subscription when there was nothing to activate", async () => {
				subscriptionService.activateFromPayment.mockResolvedValue(false);
				subscriptionService.reactivatePastDue.mockResolvedValue(true);

				const result = await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED"));

				expect(subscriptionService.reactivatePastDue).toHaveBeenCalledTimes(1);
				expect(subscriptionService.reactivatePastDue).toHaveBeenCalledWith(
					SUBSCRIPTION_ID,
					ASAAS_SUBSCRIPTION_ID,
				);
				expect(result).toEqual({ received: true });
			});

			it("should not look for a past due subscription when the payment activated one", async () => {
				await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED"));

				expect(subscriptionService.reactivatePastDue).not.toHaveBeenCalled();
			});

			it.each([
				["activated a subscription", true, false, "subscription activated"],
				["reactivated a past due subscription", false, true, "past due subscription reactivated"],
				["changed nothing", false, false, "nothing to activate"],
			])("should log that the payment %s", async (_label, activated, reactivated, outcome) => {
				subscriptionService.activateFromPayment.mockResolvedValue(activated);
				subscriptionService.reactivatePastDue.mockResolvedValue(reactivated);

				await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED"));

				expect(infoLog).toHaveBeenCalledTimes(1);
				expect(infoLog.mock.calls[0]?.join(" ")).toContain(outcome);
			});

			it("should fail the delivery when the reactivation fails, so Asaas retries it", async () => {
				const failure = new Error("connection terminated");
				subscriptionService.activateFromPayment.mockResolvedValue(false);
				subscriptionService.reactivatePastDue.mockRejectedValue(failure);

				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED")),
				).rejects.toBe(failure);
			});

			it("should pass a reference that is not ours on to the service untouched", async () => {
				await controller.handle(
					headersWith(TOKEN),
					buildEvent("PAYMENT_RECEIVED", { externalReference: "056984" }),
				);

				expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(
					"056984",
					ASAAS_SUBSCRIPTION_ID,
				);
			});

			it("should ignore fields Asaas adds to the event", async () => {
				const event = {
					...buildEvent("PAYMENT_RECEIVED", { brandNewField: { nested: 1 } }),
					extra: [],
				};

				await expect(controller.handle(headersWith(TOKEN), event)).resolves.toEqual({
					received: true,
				});
				expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(
					SUBSCRIPTION_ID,
					ASAAS_SUBSCRIPTION_ID,
				);
			});

			it("should fail the delivery when the activation fails, so Asaas retries it", async () => {
				const failure = new Error("connection terminated");
				subscriptionService.activateFromPayment.mockRejectedValue(failure);

				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED")),
				).rejects.toBe(failure);
			});

			it("should acknowledge both deliveries when the same event arrives twice", async () => {
				subscriptionService.activateFromPayment
					.mockResolvedValueOnce(true)
					.mockResolvedValueOnce(false);
				const event = buildEvent("PAYMENT_RECEIVED");

				const results = await Promise.all([
					controller.handle(headersWith(TOKEN), event),
					controller.handle(headersWith(TOKEN), event),
				]);

				expect(results).toEqual([{ received: true }, { received: true }]);
				expect(subscriptionService.activateFromPayment).toHaveBeenCalledTimes(2);
			});

			it("should acknowledge CONFIRMED and RECEIVED of the same payment arriving together", async () => {
				subscriptionService.activateFromPayment
					.mockResolvedValueOnce(true)
					.mockResolvedValueOnce(false);

				const results = await Promise.all([
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_CONFIRMED")),
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED")),
				]);

				expect(results).toEqual([{ received: true }, { received: true }]);
			});

			it("should log the outcome without the token", async () => {
				await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED"));

				const logged = infoLog.mock.calls.map((call) => call.join(" ")).join("\n");
				expect(logged).toContain("pay_fake_1");
				expect(logged).not.toContain(TOKEN);
			});

			it("should activate the subscription when the paid payment has no id", async () => {
				await controller.handle(
					headersWith(TOKEN),
					buildEvent("PAYMENT_RECEIVED", { id: undefined }),
				);

				expect(subscriptionService.activateFromPayment).toHaveBeenCalledWith(
					SUBSCRIPTION_ID,
					ASAAS_SUBSCRIPTION_ID,
				);
			});

			it("should log the outcome when the paid payment has no id", async () => {
				await controller.handle(
					headersWith(TOKEN),
					buildEvent("PAYMENT_RECEIVED", { id: undefined }),
				);

				expect(infoLog).toHaveBeenCalledTimes(1);
			});

			it("should not mark past due or deactivate anything on a paid event", async () => {
				await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED"));

				expect(subscriptionService.markPastDue).not.toHaveBeenCalled();
				expect(subscriptionService.deactivate).not.toHaveBeenCalled();
			});
		});

		describe("past due events", () => {
			it("should mark the subscription as past due on PAYMENT_OVERDUE", async () => {
				const result = await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_OVERDUE"));

				expect(subscriptionService.markPastDue).toHaveBeenCalledTimes(1);
				expect(subscriptionService.markPastDue).toHaveBeenCalledWith(
					SUBSCRIPTION_ID,
					ASAAS_SUBSCRIPTION_ID,
				);
				expect(result).toEqual({ received: true });
			});

			it("should not activate or deactivate anything on PAYMENT_OVERDUE", async () => {
				await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_OVERDUE"));

				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
				expect(subscriptionService.deactivate).not.toHaveBeenCalled();
			});

			it.each([
				["there was an active subscription", true],
				["there was no active subscription", false],
			])("should warn and acknowledge when %s", async (_label, marked) => {
				subscriptionService.markPastDue.mockResolvedValue(marked);

				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_OVERDUE")),
				).resolves.toEqual({ received: true });
				expect(warnLog).toHaveBeenCalledTimes(1);
			});

			it("should fail the delivery when marking past due fails, so Asaas retries it", async () => {
				const failure = new Error("connection terminated");
				subscriptionService.markPastDue.mockRejectedValue(failure);

				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_OVERDUE")),
				).rejects.toBe(failure);
			});
		});

		describe("ended events", () => {
			it.each(["PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED"])(
				"should deactivate the subscription of the payment on %s",
				async (event) => {
					const result = await controller.handle(headersWith(TOKEN), buildEvent(event));

					expect(subscriptionService.deactivate).toHaveBeenCalledTimes(1);
					expect(subscriptionService.deactivate).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						ASAAS_SUBSCRIPTION_ID,
						event,
					);
					expect(result).toEqual({ received: true });
				},
			);

			it.each(["SUBSCRIPTION_INACTIVATED", "SUBSCRIPTION_DELETED"])(
				"should deactivate the subscription carried by %s",
				async (event) => {
					const body = {
						...buildEvent(event, null),
						subscription: {
							object: "subscription",
							id: ASAAS_SUBSCRIPTION_ID,
							externalReference: SUBSCRIPTION_ID,
							status: "INACTIVE",
						},
					};

					await controller.handle(headersWith(TOKEN), body);

					expect(subscriptionService.deactivate).toHaveBeenCalledWith(
						SUBSCRIPTION_ID,
						ASAAS_SUBSCRIPTION_ID,
						event,
					);
				},
			);

			it("should send the Asaas subscription id as a fallback when the subscription event has no external reference", async () => {
				const body = {
					...buildEvent("SUBSCRIPTION_DELETED", null),
					subscription: { id: ASAAS_SUBSCRIPTION_ID, externalReference: null },
				};

				await controller.handle(headersWith(TOKEN), body);

				expect(subscriptionService.deactivate).toHaveBeenCalledWith(
					null,
					ASAAS_SUBSCRIPTION_ID,
					"SUBSCRIPTION_DELETED",
				);
			});

			it("should leave the lookup to the service when the event carries no payment or subscription", async () => {
				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("SUBSCRIPTION_DELETED", null)),
				).resolves.toEqual({ received: true });

				expect(subscriptionService.deactivate).toHaveBeenCalledWith(
					undefined,
					undefined,
					"SUBSCRIPTION_DELETED",
				);
			});

			it("should not activate or mark past due anything on an ended event", async () => {
				await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_REFUNDED"));

				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
				expect(subscriptionService.markPastDue).not.toHaveBeenCalled();
			});

			it.each([
				["there was a live subscription", true],
				["there was no live subscription", false],
			])("should warn and acknowledge when %s", async (_label, ended) => {
				subscriptionService.deactivate.mockResolvedValue(ended);

				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_REFUNDED")),
				).resolves.toEqual({ received: true });
				expect(warnLog).toHaveBeenCalledTimes(1);
			});

			it("should fail the delivery when the deactivation fails, so Asaas retries it", async () => {
				const failure = new Error("connection terminated");
				subscriptionService.deactivate.mockRejectedValue(failure);

				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_REFUNDED")),
				).rejects.toBe(failure);
			});
		});

		describe("watched events", () => {
			it.each(["PAYMENT_DELETED", "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED"])(
				"should warn about '%s' without changing the subscription",
				async (event) => {
					await expect(controller.handle(headersWith(TOKEN), buildEvent(event))).resolves.toEqual({
						received: true,
					});

					expect(warnLog).toHaveBeenCalledTimes(1);
					expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
					expect(subscriptionService.markPastDue).not.toHaveBeenCalled();
					expect(subscriptionService.deactivate).not.toHaveBeenCalled();
				},
			);
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
				await expect(controller.handle(headersWith(TOKEN), buildEvent(event))).resolves.toEqual({
					received: true,
				});
				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
				expect(subscriptionService.markPastDue).not.toHaveBeenCalled();
				expect(subscriptionService.deactivate).not.toHaveBeenCalled();
			});

			it("should acknowledge a paid event that carries no payment", async () => {
				await expect(
					controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_RECEIVED", null)),
				).resolves.toEqual({ received: true });
				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
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
					{
						event: "PAYMENT_RECEIVED",
						payment: { id: "pay_fake_1", externalReference: 56984 },
					},
				],
				[
					"an external reference that is an object",
					{
						event: "PAYMENT_RECEIVED",
						payment: { id: "pay_fake_1", externalReference: {} },
					},
				],
			])("should acknowledge and ignore a body that is %s", async (_label, body) => {
				await expect(controller.handle(headersWith(TOKEN), body)).resolves.toEqual({
					received: true,
				});
				expect(subscriptionService.activateFromPayment).not.toHaveBeenCalled();
			});

			it("should warn when the body is malformed", async () => {
				await controller.handle(headersWith(TOKEN), {});

				expect(warnLog).toHaveBeenCalledTimes(1);
			});

			it("should not warn when the body is a well formed event it does not handle", async () => {
				await controller.handle(headersWith(TOKEN), buildEvent("PAYMENT_CREATED"));

				expect(warnLog).not.toHaveBeenCalled();
			});
		});
	});
});
