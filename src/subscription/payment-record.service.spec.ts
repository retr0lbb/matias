import { getDrizzleToken } from "@nestjs/drizzle";
import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { paymentTables } from "../db/schemas/payments.js";
import { subscriptionTable } from "../db/schemas/subscriptions.js";
import { PaymentRecordService, type WebhookCharge } from "./payment-record.service.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUBSCRIPTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASAAS_SUBSCRIPTION_ID = "sub_fake_1";
const STORED_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type PaymentRow = typeof paymentTables.$inferInsert;

interface ConflictTarget {
	target: unknown;
}

interface ConflictUpdate extends ConflictTarget {
	set: { status?: string; paidAt?: SQL };
	setWhere?: SQL;
}

const dialect = new PgDialect();

/** SQL text and bound values of a Drizzle condition. */
const compile = (condition: SQL | undefined) => {
	if (!condition) throw new Error("expected a SQL condition, got undefined");
	return dialect.sqlToQuery(condition);
};

/**
 * Fake Drizzle client with the two chains the service uses:
 * `select().from().where().limit()` resolves with the subscriptions found, and
 * `insert().values().onConflictDo*().returning()` with the rows written.
 */
const createDbMock = () => {
	const selectChain = {
		from: vi.fn<(table: unknown) => unknown>(),
		where: vi.fn<(condition: SQL | undefined) => unknown>(),
		limit: vi.fn<(limit: number) => Promise<unknown[]>>(),
	};
	selectChain.from.mockReturnValue(selectChain);
	selectChain.where.mockReturnValue(selectChain);

	const insertChain = {
		values: vi.fn<(row: PaymentRow) => unknown>(),
		onConflictDoNothing: vi.fn<(config: ConflictTarget) => unknown>(),
		onConflictDoUpdate: vi.fn<(config: ConflictUpdate) => unknown>(),
		returning: vi.fn<(fields: unknown) => Promise<unknown[]>>(),
	};
	insertChain.values.mockReturnValue(insertChain);
	insertChain.onConflictDoNothing.mockReturnValue(insertChain);
	insertChain.onConflictDoUpdate.mockReturnValue(insertChain);

	return {
		select: vi.fn<(fields: unknown) => unknown>(() => selectChain),
		insert: vi.fn<(table: unknown) => unknown>(() => insertChain),
		selectChain,
		insertChain,
	};
};

/** A charge as the webhook hands it over after the body was parsed. */
const buildCharge = (overrides: Partial<WebhookCharge> = {}): WebhookCharge => ({
	id: "pay_fake_1",
	customer: "cus_fake_1",
	subscription: ASAAS_SUBSCRIPTION_ID,
	externalReference: SUBSCRIPTION_ID,
	billingType: "PIX",
	value: 29.9,
	dueDate: "2026-12-13",
	...overrides,
});

describe("PaymentRecordService", () => {
	let service: PaymentRecordService;
	let db: ReturnType<typeof createDbMock>;

	/** The row handed to `insert().values()`. */
	const insertedRow = () => db.insertChain.values.mock.calls[0]?.[0];
	/** The config handed to `onConflictDoUpdate()`. */
	const conflictUpdate = () => db.insertChain.onConflictDoUpdate.mock.calls[0]?.[0];

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		db = createDbMock();
		db.selectChain.limit.mockResolvedValue([{ id: SUBSCRIPTION_ID, userId: USER_ID }]);
		db.insertChain.returning.mockResolvedValue([{ id: STORED_ID }]);

		const module = await Test.createTestingModule({
			providers: [PaymentRecordService, { provide: getDrizzleToken(), useValue: db }],
		}).compile();

		service = module.get(PaymentRecordService);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe("recordFromWebhook", () => {
		describe("events", () => {
			it.each([
				["PAYMENT_CREATED", "PENDING"],
				["PAYMENT_CONFIRMED", "PAID"],
				["PAYMENT_RECEIVED", "PAID"],
				["PAYMENT_OVERDUE", "OVERDUE"],
				["PAYMENT_REFUNDED", "REFUNDED"],
				["PAYMENT_CHARGEBACK_REQUESTED", "REFUNDED"],
				["PAYMENT_DELETED", "FAILED"],
				["PAYMENT_CREDIT_CARD_CAPTURE_REFUSED", "FAILED"],
			])("should store the charge of %s as %s", async (event, status) => {
				const result = await service.recordFromWebhook(event, buildCharge());

				expect(result).toBe(true);
				expect(db.insert).toHaveBeenCalledTimes(1);
				expect(db.insert).toHaveBeenCalledWith(paymentTables);
				expect(insertedRow()?.status).toBe(status);
			});

			it.each([
				"PAYMENT_UPDATED",
				"PAYMENT_RESTORED",
				"PAYMENT_AUTHORIZED",
				"SUBSCRIPTION_CREATED",
				"SUBSCRIPTION_DELETED",
				"payment_created",
				"PAYMENT_CREATED ",
				"",
			])("should write nothing when the event is '%s'", async (event) => {
				const result = await service.recordFromWebhook(event, buildCharge());

				expect(result).toBe(false);
				expect(db.select).not.toHaveBeenCalled();
				expect(db.insert).not.toHaveBeenCalled();
			});

			it.each(["toString", "constructor", "hasOwnProperty"])(
				"should write nothing when the event is the object property '%s'",
				async (event) => {
					const result = await service.recordFromWebhook(event, buildCharge());

					expect(result).toBe(false);
					expect(db.insert).not.toHaveBeenCalled();
				},
			);
		});

		describe("subscription lookup", () => {
			it("should look the subscription up by the local id when the external reference is ours", async () => {
				await service.recordFromWebhook("PAYMENT_CREATED", buildCharge());

				const condition = compile(db.selectChain.where.mock.calls[0]?.[0]);
				expect(db.selectChain.from).toHaveBeenCalledWith(subscriptionTable);
				expect(condition.sql).toContain('"id"');
				expect(condition.params).toEqual([SUBSCRIPTION_ID]);
			});

			it.each([
				["is null", null],
				["is undefined", undefined],
				["is empty", ""],
				["is not one of our ids", "056984"],
				["is a uuid with something appended", `${SUBSCRIPTION_ID}-x`],
			])(
				"should look the subscription up by the Asaas id when the external reference %s",
				async (_label, externalReference) => {
					await service.recordFromWebhook("PAYMENT_CREATED", buildCharge({ externalReference }));

					const condition = compile(db.selectChain.where.mock.calls[0]?.[0]);
					expect(condition.sql).toContain('"asaas_subscription_id"');
					expect(condition.params).toEqual([ASAAS_SUBSCRIPTION_ID]);
				},
			);

			it("should read a single subscription", async () => {
				await service.recordFromWebhook("PAYMENT_CREATED", buildCharge());

				expect(db.select).toHaveBeenCalledTimes(1);
				expect(db.selectChain.limit).toHaveBeenCalledWith(1);
			});

			it.each([
				["null", null, null],
				["undefined", undefined, undefined],
				["empty", "", ""],
				["a foreign reference and no Asaas id", "056984", null],
			])(
				"should write nothing without reading the database when both ids are %s",
				async (_label, externalReference, subscription) => {
					const result = await service.recordFromWebhook(
						"PAYMENT_RECEIVED",
						buildCharge({ externalReference, subscription }),
					);

					expect(result).toBe(false);
					expect(db.select).not.toHaveBeenCalled();
					expect(db.insert).not.toHaveBeenCalled();
				},
			);

			it("should write nothing when the charge belongs to no local subscription", async () => {
				db.selectChain.limit.mockResolvedValue([]);

				const result = await service.recordFromWebhook("PAYMENT_RECEIVED", buildCharge());

				expect(result).toBe(false);
				expect(db.insert).not.toHaveBeenCalled();
			});

			it("should link the charge to the subscription found and to its user", async () => {
				const otherSubscription = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
				const otherUser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
				db.selectChain.limit.mockResolvedValue([{ id: otherSubscription, userId: otherUser }]);

				await service.recordFromWebhook(
					"PAYMENT_CREATED",
					buildCharge({ externalReference: null }),
				);

				expect(insertedRow()).toMatchObject({
					subscriptionId: otherSubscription,
					userId: otherUser,
				});
			});

			it("should propagate the error when reading the subscription fails", async () => {
				const failure = new Error("connection terminated");
				db.selectChain.limit.mockRejectedValue(failure);

				await expect(service.recordFromWebhook("PAYMENT_RECEIVED", buildCharge())).rejects.toBe(
					failure,
				);
				expect(db.insert).not.toHaveBeenCalled();
			});
		});

		describe("stored row", () => {
			it("should store every field of a new charge", async () => {
				await service.recordFromWebhook("PAYMENT_CREATED", buildCharge());

				expect(insertedRow()).toEqual({
					userId: USER_ID,
					subscriptionId: SUBSCRIPTION_ID,
					asaasPaymentId: "pay_fake_1",
					customerId: "cus_fake_1",
					billingType: "PIX",
					dueDate: "2026-12-13",
					status: "PENDING",
					value: 2990,
					paidAt: null,
				});
			});

			it.each([
				["PIX", "PIX"],
				["BOLETO", "BOLETO"],
				["CREDIT_CARD", "CARTAO_DE_CREDITO"],
			])("should store the Asaas billing type %s as %s", async (billingType, stored) => {
				await service.recordFromWebhook("PAYMENT_CREATED", buildCharge({ billingType }));

				expect(insertedRow()?.billingType).toBe(stored);
			});

			it.each([
				[29.9, 2990],
				[19.99, 1999],
				[100, 10000],
				[0.01, 1],
				[0, 0],
			])("should store the value %d BRL as %i cents", async (value, cents) => {
				await service.recordFromWebhook("PAYMENT_CREATED", buildCharge({ value }));

				expect(insertedRow()?.value).toBe(cents);
			});

			it.each([
				["is undefined", undefined],
				["is null", null],
				["is empty", ""],
				["is in the Brazilian format", "13/12/2026"],
				["carries a time", "2026-12-13T00:00:00"],
			])("should store no due date when it %s", async (_label, dueDate) => {
				const result = await service.recordFromWebhook("PAYMENT_CREATED", buildCharge({ dueDate }));

				expect(result).toBe(true);
				expect(insertedRow()?.dueDate).toBeNull();
			});

			it.each(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"])(
				"should store the current time as the payment time on %s",
				async (event) => {
					await service.recordFromWebhook(event, buildCharge());

					expect(insertedRow()?.paidAt).toEqual(NOW);
				},
			);

			it.each([
				"PAYMENT_CREATED",
				"PAYMENT_OVERDUE",
				"PAYMENT_REFUNDED",
				"PAYMENT_CHARGEBACK_REQUESTED",
				"PAYMENT_DELETED",
				"PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
			])("should store no payment time on %s", async (event) => {
				await service.recordFromWebhook(event, buildCharge());

				expect(insertedRow()?.paidAt).toBeNull();
			});

			it("should not change the charge it received", async () => {
				const charge = buildCharge();
				const before = structuredClone(charge);

				await service.recordFromWebhook("PAYMENT_RECEIVED", charge);

				expect(charge).toEqual(before);
			});
		});

		describe("charges missing required data", () => {
			it.each<[string, Partial<WebhookCharge>]>([
				["no id", { id: undefined }],
				["a null id", { id: null }],
				["an empty id", { id: "" }],
				["no customer", { customer: undefined }],
				["a null customer", { customer: null }],
				["an empty customer", { customer: "" }],
				["no billing type", { billingType: undefined }],
				["a null billing type", { billingType: null }],
				["an empty billing type", { billingType: "" }],
				["the UNDEFINED billing type", { billingType: "UNDEFINED" }],
				["a billing type we do not store", { billingType: "DEBIT_CARD" }],
				["a lower case billing type", { billingType: "pix" }],
				["no value", { value: undefined }],
				["a null value", { value: null }],
				["a value that is not a number", { value: Number.NaN }],
				["an infinite value", { value: Number.POSITIVE_INFINITY }],
			])("should write nothing when the charge has %s", async (_label, overrides) => {
				const result = await service.recordFromWebhook("PAYMENT_RECEIVED", buildCharge(overrides));

				expect(result).toBe(false);
				expect(db.insert).not.toHaveBeenCalled();
			});
		});

		describe("new charges", () => {
			it("should leave a charge that is already stored untouched", async () => {
				await service.recordFromWebhook("PAYMENT_CREATED", buildCharge());

				expect(db.insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
				expect(db.insertChain.onConflictDoNothing).toHaveBeenCalledWith({
					target: paymentTables.asaasPaymentId,
				});
				expect(db.insertChain.onConflictDoUpdate).not.toHaveBeenCalled();
			});

			it("should return true when the charge was stored", async () => {
				await expect(service.recordFromWebhook("PAYMENT_CREATED", buildCharge())).resolves.toBe(
					true,
				);
			});

			it("should return false when the charge was already stored", async () => {
				db.insertChain.returning.mockResolvedValue([]);

				await expect(service.recordFromWebhook("PAYMENT_CREATED", buildCharge())).resolves.toBe(
					false,
				);
			});
		});

		describe("status changes", () => {
			it.each([
				["PAYMENT_CONFIRMED", "PAID"],
				["PAYMENT_RECEIVED", "PAID"],
				["PAYMENT_OVERDUE", "OVERDUE"],
				["PAYMENT_REFUNDED", "REFUNDED"],
				["PAYMENT_CHARGEBACK_REQUESTED", "REFUNDED"],
				["PAYMENT_DELETED", "FAILED"],
				["PAYMENT_CREDIT_CARD_CAPTURE_REFUSED", "FAILED"],
			])("should move the stored charge to the status of %s", async (event, status) => {
				await service.recordFromWebhook(event, buildCharge());

				expect(db.insertChain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
				expect(conflictUpdate()?.target).toBe(paymentTables.asaasPaymentId);
				expect(conflictUpdate()?.set.status).toBe(status);
				expect(db.insertChain.onConflictDoNothing).not.toHaveBeenCalled();
			});

			it.each(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"])(
				"should not mark a refunded charge as paid on %s",
				async (event) => {
					await service.recordFromWebhook(event, buildCharge());

					const guard = compile(conflictUpdate()?.setWhere);
					expect(guard.sql).toContain('"status" <> ');
					expect(guard.params).toEqual(["REFUNDED"]);
				},
			);

			it("should mark as overdue only a charge that is still pending", async () => {
				await service.recordFromWebhook("PAYMENT_OVERDUE", buildCharge());

				const guard = compile(conflictUpdate()?.setWhere);
				expect(guard.sql).toContain('"status" = ');
				expect(guard.params).toEqual(["PENDING"]);
			});

			it.each(["PAYMENT_DELETED", "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED"])(
				"should mark as failed only a charge that is pending or overdue on %s",
				async (event) => {
					await service.recordFromWebhook(event, buildCharge());

					const guard = compile(conflictUpdate()?.setWhere);
					expect(guard.sql).toContain('"status" in ');
					expect(guard.params).toEqual(["PENDING", "OVERDUE"]);
				},
			);

			it.each(["PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED"])(
				"should mark the charge as refunded whatever its status on %s",
				async (event) => {
					await service.recordFromWebhook(event, buildCharge());

					expect(conflictUpdate()?.setWhere).toBeUndefined();
				},
			);

			it.each(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"])(
				"should keep the first payment time of a stored charge on %s",
				async (event) => {
					await service.recordFromWebhook(event, buildCharge());

					const paidAt = compile(conflictUpdate()?.set.paidAt);
					expect(paidAt.sql).toBe('coalesce("payments"."paid_at", now())');
				},
			);

			it.each([
				"PAYMENT_OVERDUE",
				"PAYMENT_REFUNDED",
				"PAYMENT_CHARGEBACK_REQUESTED",
				"PAYMENT_DELETED",
				"PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
			])("should not touch the payment time of a stored charge on %s", async (event) => {
				await service.recordFromWebhook(event, buildCharge());

				expect(conflictUpdate()?.set).toEqual({ status: insertedRow()?.status });
			});

			it("should return true when the charge was stored or moved", async () => {
				await expect(service.recordFromWebhook("PAYMENT_RECEIVED", buildCharge())).resolves.toBe(
					true,
				);
			});

			it("should return false when the change would move the charge backwards", async () => {
				db.insertChain.returning.mockResolvedValue([]);

				await expect(service.recordFromWebhook("PAYMENT_OVERDUE", buildCharge())).resolves.toBe(
					false,
				);
			});
		});

		describe("write failures", () => {
			it.each(["PAYMENT_CREATED", "PAYMENT_RECEIVED"])(
				"should propagate the error when writing the charge of %s fails",
				async (event) => {
					const failure = new Error("connection terminated");
					db.insertChain.returning.mockRejectedValue(failure);

					await expect(service.recordFromWebhook(event, buildCharge())).rejects.toBe(failure);
				},
			);
		});
	});
});
