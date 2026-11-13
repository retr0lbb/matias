import {
	BadGatewayException,
	BadRequestException,
	ConflictException,
	InternalServerErrorException,
	ServiceUnavailableException,
	UnauthorizedException,
} from "@nestjs/common";
import { getDrizzleToken } from "@nestjs/drizzle";
import { Test } from "@nestjs/testing";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Mock, MockedFunction } from "vitest";
import { planTable } from "../db/schemas/plans.js";
import { promoCodeRedemptions } from "../db/schemas/promo-code-redemptions.js";
import { promoCodesTable } from "../db/schemas/promo-codes.js";
import { subscriptionTable } from "../db/schemas/subscriptions.js";
import { type User, userTable } from "../db/schemas/user.js";
import type { AsaasCustomer } from "../payment/dto/asaas-customer.dto.js";
import type { AsaasPayment, AsaasSubscription } from "../payment/dto/asaas-subscription.dto.js";
import { PaymentService } from "../payment/payment.service.js";
import type { SubscribeDTO } from "./dto/create-subscription.dto.js";
import { SubscriptionService } from "./subscription.service.js";

// Tests marked with "GAP:" describe behavior the service should have but does
// not have yet. They are expected to fail until the source is fixed.

const NOW = new Date("2026-11-13T12:00:00.000Z");
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUBSCRIPTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROMO_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type PlanRow = typeof planTable.$inferSelect;
type PromoRow = typeof promoCodesTable.$inferSelect;
type SubscriptionRow = typeof subscriptionTable.$inferSelect;

type Operation = "select" | "insert" | "update" | "delete";

/** One query the service awaited, in execution order. */
interface QueryRecord {
	operation: Operation;
	table: string;
	values?: unknown;
	set?: unknown;
	where?: SQL;
	limit?: number;
	returning: boolean;
	inTransaction: boolean;
	lock?: string;
}

type QueryHandler = Mock<(query: QueryRecord) => Promise<unknown[]>>;

const dialect = new PgDialect();

/** Values bound in the WHERE clause of a recorded query. */
const whereParams = (query: QueryRecord | undefined): unknown[] =>
	query?.where ? dialect.sqlToQuery(query.where).params : [];

/**
 * Fake Drizzle client. Every chain (`select().from().where()`, `insert()...`)
 * runs only when awaited, is recorded in `queries`, and resolves with whatever
 * the handler registered through `on(operation, table)` returns (`[]` when no
 * handler was configured).
 */
const createDbMock = () => {
	const queries: QueryRecord[] = [];
	const handlers = new Map<string, QueryHandler>();

	const handlerFor = (operation: Operation, tableName: string): QueryHandler => {
		const key = `${operation}:${tableName}`;
		let handler = handlers.get(key);
		if (!handler) {
			handler = vi.fn<(query: QueryRecord) => Promise<unknown[]>>().mockResolvedValue([]);
			handlers.set(key, handler);
		}
		return handler;
	};

	const chainFor = (operation: Operation, inTransaction: boolean, table?: Table) => {
		const query: QueryRecord = {
			operation,
			table: table ? getTableName(table) : "",
			returning: false,
			inTransaction,
		};

		const chain = {
			from(source: Table) {
				query.table = getTableName(source);
				return chain;
			},
			values(values: unknown) {
				query.values = values;
				return chain;
			},
			set(values: unknown) {
				query.set = values;
				return chain;
			},
			where(condition: SQL | undefined) {
				query.where = condition;
				return chain;
			},
			limit(limit: number) {
				query.limit = limit;
				return chain;
			},
			returning() {
				query.returning = true;
				return chain;
			},
			for(strength: "update" | "share" | "no key update" | "key share") {
				query.lock = strength;
				return chain;
			},
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle builders are thenables
			// biome-ignore lint/suspicious/noThenProperty: <explanation>
			then<Result>(
				onFulfilled: (rows: unknown[]) => Result,
				onRejected?: (reason: unknown) => Result,
			) {
				queries.push(query);
				return handlerFor(query.operation, query.table)(query).then(onFulfilled, onRejected);
			},
		};

		return chain;
	};

	const clientFor = (inTransaction: boolean) => ({
		select: vi.fn((_fields?: unknown) => chainFor("select", inTransaction)),
		insert: vi.fn((table: Table) => chainFor("insert", inTransaction, table)),
		update: vi.fn((table: Table) => chainFor("update", inTransaction, table)),
		delete: vi.fn((table: Table) => chainFor("delete", inTransaction, table)),
		transaction: vi.fn(async (callback: (tx: Client) => Promise<unknown>) => {
			const startedAt = queries.length;
			try {
				return await callback(clientFor(true));
			} catch (error) {
				// Emula o rollback: escritas feitas dentro da transação não aconteceram.
				const kept = queries.slice(startedAt).filter((query) => query.operation === "select");
				queries.splice(startedAt, queries.length - startedAt, ...kept);
				throw error;
			}
		}),
	});

	type Client = ReturnType<typeof clientFor>;

	return {
		...clientFor(false),
		transaction: vi.fn(async (callback: (tx: Client) => Promise<unknown>) =>
			callback(clientFor(true)),
		),
		queries,
		/** Handler that decides what `operation` on `table` resolves with. */
		on: (operation: Operation, table: Table) => handlerFor(operation, getTableName(table)),
		/** Recorded queries of one kind, in execution order. */
		ran: (operation: Operation, table: Table) =>
			queries.filter(
				(query) => query.operation === operation && query.table === getTableName(table),
			),
	};
};

type DbMock = ReturnType<typeof createDbMock>;

const createPaymentServiceMock = () => ({
	createCustomer: vi.fn() as unknown as MockedFunction<PaymentService["createCustomer"]>,
	createSubscription: vi.fn() as unknown as MockedFunction<PaymentService["createSubscription"]>,
	listSubscriptionPayments: vi.fn() as unknown as MockedFunction<
		PaymentService["listSubscriptionPayments"]
	>,
});

type PaymentServiceMock = ReturnType<typeof createPaymentServiceMock>;

const buildUser = (overrides: Partial<User> = {}): User => ({
	id: USER_ID,
	name: "Fake User",
	email: "fake.user@example.com",
	emailVerified: true,
	passwordHash: "hashed-password",
	loginProvider: "LOCAL",
	googleSubject: null,
	plan: "FREE",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	cycleAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
	...overrides,
});

const buildPlan = (overrides: Partial<PlanRow> = {}): PlanRow => ({
	id: PLAN_ID,
	name: "Pro",
	description: null,
	price: 2990,
	currency: "BRL",
	billing_interval: "MONTHLY",
	is_active: true,
	limits: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	...overrides,
});

const buildPromo = (overrides: Partial<PromoRow> = {}): PromoRow => ({
	id: PROMO_ID,
	code: "FAKE10",
	description: null,
	discountType: "PERCENTAGE",
	durationInCicle: 3,
	discountValue: 10,
	maxRedemptionsGlobal: null,
	maxRedemptionsUser: null,
	startsAt: new Date("2026-01-01T00:00:00.000Z"),
	endsAt: new Date("2027-01-01T00:00:00.000Z"),
	isValid: true,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	...overrides,
});

const buildSubscriptionRow = (overrides: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
	id: SUBSCRIPTION_ID,
	user_id: USER_ID,
	plan_id: PLAN_ID,
	status: "PENDING",
	subscribedAt: NOW,
	cancelledAt: null,
	cancelReason: null,
	customerId: null,
	asaasSubscriptionId: null,
	...overrides,
});

const buildPayload = (overrides: Partial<SubscribeDTO> = {}): SubscribeDTO => ({
	planId: PLAN_ID,
	paymentMethod: "PIX",
	fullName: "Fake User Full Name",
	cpf: "529.982.247-25",
	...overrides,
});

const buildAsaasCustomer = (overrides: Partial<AsaasCustomer> = {}): AsaasCustomer => ({
	object: "customer",
	id: "cus_fake_1",
	dateCreated: "2026-11-13",
	name: "Fake User Full Name",
	cpfCnpj: "52998224725",
	personType: "FISICA",
	notificationDisabled: false,
	deleted: false,
	...overrides,
});

const buildAsaasSubscription = (overrides: Partial<AsaasSubscription> = {}): AsaasSubscription => ({
	object: "subscription",
	id: "sub_fake_1",
	dateCreated: "2026-11-13",
	customer: "cus_fake_1",
	billingType: "PIX",
	cycle: "MONTHLY",
	value: 29.9,
	nextDueDate: "2026-12-13",
	status: "ACTIVE",
	deleted: false,
	...overrides,
});

const buildAsaasPayment = (overrides: Partial<AsaasPayment> = {}): AsaasPayment => ({
	object: "payment",
	id: "pay_fake_1",
	customer: "cus_fake_1",
	subscription: "sub_fake_1",
	externalReference: SUBSCRIPTION_ID,
	status: "PENDING",
	billingType: "PIX",
	value: 29.9,
	dueDate: "2026-11-13",
	invoiceUrl: "https://sandbox.asaas.example/i/fake_1",
	...overrides,
});

describe("SubscriptionService", () => {
	let service: SubscriptionService;
	let db: DbMock;
	let payment: PaymentServiceMock;

	/** Everything a first-time subscriber needs for the whole flow to succeed. */
	const arrangeHappyPath = () => {
		db.on("select", userTable).mockResolvedValue([buildUser()]);
		db.on("select", planTable).mockResolvedValue([buildPlan()]);
		db.on("insert", subscriptionTable).mockResolvedValue([buildSubscriptionRow()]);
		payment.createCustomer.mockResolvedValue(buildAsaasCustomer());
		payment.createSubscription.mockResolvedValue(buildAsaasSubscription());
		payment.listSubscriptionPayments.mockResolvedValue([buildAsaasPayment()]);
	};

	const arrangePromo = (overrides: Partial<PromoRow> = {}) => {
		db.on("select", promoCodesTable).mockResolvedValue([buildPromo(overrides)]);
	};

	const expectNothingWritten = () => {
		expect(db.ran("insert", subscriptionTable)).toHaveLength(0);
		expect(db.ran("insert", promoCodeRedemptions)).toHaveLength(0);
		expect(payment.createCustomer).not.toHaveBeenCalled();
		expect(payment.createSubscription).not.toHaveBeenCalled();
	};

	beforeEach(async () => {
		db = createDbMock();
		payment = createPaymentServiceMock();

		const module = await Test.createTestingModule({
			providers: [
				SubscriptionService,
				{ provide: getDrizzleToken(), useValue: db },
				{ provide: PaymentService, useValue: payment },
			],
		}).compile();

		service = module.get(SubscriptionService);

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		// The service prints the promo code while it is being developed.
		vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe("createSubscription", () => {
		describe("user", () => {
			it("should throw UnauthorizedException when the user no longer exists", async () => {
				arrangeHappyPath();
				db.on("select", userTable).mockResolvedValue([]);

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					UnauthorizedException,
				);
				expectNothingWritten();
			});

			it("should look the user up by the id of the authenticated user", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				expect(whereParams(db.ran("select", userTable)[0])).toEqual([USER_ID]);
			});

			it("should reject without writing anything when the user lookup fails", async () => {
				arrangeHappyPath();
				db.on("select", userTable).mockRejectedValue(new Error("connection terminated"));

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					"connection terminated",
				);
				expectNothingWritten();
			});
		});

		describe("promo code", () => {
			it("should not query promo codes when no discount code is sent", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				expect(db.ran("select", promoCodesTable)).toHaveLength(0);
				expect(db.ran("insert", promoCodeRedemptions)).toHaveLength(0);
			});

			it("should not query promo codes when the discount code is an empty string", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload({ discountCode: "" }));

				expect(db.ran("select", promoCodesTable)).toHaveLength(0);
			});

			it("should throw BadRequestException when the discount code does not exist", async () => {
				arrangeHappyPath();
				db.on("select", promoCodesTable).mockResolvedValue([]);

				const act = service.createSubscription(buildUser(), buildPayload({ discountCode: "NOPE" }));

				await expect(act).rejects.toThrow(BadRequestException);
				await expect(act).rejects.toThrow("Invalid promotional code");
				expectNothingWritten();
			});

			it("should look the promo code up by the code that was sent", async () => {
				arrangeHappyPath();
				arrangePromo();

				await service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" }));

				expect(whereParams(db.ran("select", promoCodesTable)[0])).toEqual(["FAKE10"]);
			});

			it.each([
				["false", false],
				["null", null],
			])("should throw BadRequestException when the code has isValid %s", async (_l, isValid) => {
				arrangeHappyPath();
				arrangePromo({ isValid });

				const act = service.createSubscription(
					buildUser(),
					buildPayload({ discountCode: "FAKE10" }),
				);

				await expect(act).rejects.toThrow(BadRequestException);
				await expect(act).rejects.toThrow("Discount code is invalid");
				expectNothingWritten();
			});

			it("should throw BadRequestException when the code expired one millisecond ago", async () => {
				arrangeHappyPath();
				arrangePromo({ endsAt: new Date(NOW.getTime() - 1) });

				const act = service.createSubscription(
					buildUser(),
					buildPayload({ discountCode: "FAKE10" }),
				);

				await expect(act).rejects.toThrow(BadRequestException);
				await expect(act).rejects.toThrow("Discount code is expired");
				expectNothingWritten();
			});

			it("should accept the code when it expires exactly now", async () => {
				arrangeHappyPath();
				arrangePromo({ endsAt: new Date(NOW) });

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).resolves.toBeDefined();
			});

			// GAP: startsAt is stored but never checked, so a code scheduled for the
			// future can already be redeemed.
			it("should throw BadRequestException when the code has not started yet", async () => {
				arrangeHappyPath();
				arrangePromo({ startsAt: new Date(NOW.getTime() + 60_000) });

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).rejects.toThrow(BadRequestException);
			});

			it.each([
				["equals the limit", 5, 5],
				["is above the limit", 6, 5],
				["is zero and the limit is zero", 0, 0],
			])(
				"should throw BadRequestException when the global redemption count %s",
				async (_label, redeemed, limit) => {
					arrangeHappyPath();
					arrangePromo({ maxRedemptionsGlobal: limit });
					db.on("select", promoCodeRedemptions).mockResolvedValue([{ count: redeemed }]);

					const act = service.createSubscription(
						buildUser(),
						buildPayload({ discountCode: "FAKE10" }),
					);

					await expect(act).rejects.toThrow(BadRequestException);
					await expect(act).rejects.toThrow("Maximum global request for this code");
					expectNothingWritten();
				},
			);

			it("should accept the code when the global redemption count is one below the limit", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsGlobal: 5 });
				db.on("select", promoCodeRedemptions).mockResolvedValue([{ count: 4 }]);

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).resolves.toBeDefined();
			});

			it("should count only APPLIED redemptions of the code for the global limit", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsGlobal: 5 });
				db.on("select", promoCodeRedemptions).mockResolvedValue([{ count: 0 }]);

				await service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" }));

				expect(whereParams(db.ran("select", promoCodeRedemptions)[0])).toEqual([
					PROMO_ID,
					"APPLIED",
				]);
			});

			it("should not count redemptions when the code has no limits", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsGlobal: null, maxRedemptionsUser: null });

				await service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" }));

				expect(db.ran("select", promoCodeRedemptions)).toHaveLength(0);
			});

			it.each([
				["equals the limit", 1, 1],
				["is above the limit", 3, 2],
			])(
				"should throw BadRequestException when the user redemption count %s",
				async (_label, redeemed, limit) => {
					arrangeHappyPath();
					arrangePromo({ maxRedemptionsUser: limit });
					db.on("select", promoCodeRedemptions).mockResolvedValue([{ count: redeemed }]);

					const act = service.createSubscription(
						buildUser(),
						buildPayload({ discountCode: "FAKE10" }),
					);

					await expect(act).rejects.toThrow(BadRequestException);
					await expect(act).rejects.toThrow("Code is already taken");
					expectNothingWritten();
				},
			);

			it("should accept the code when the user redemption count is below the limit", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsUser: 2 });
				db.on("select", promoCodeRedemptions).mockResolvedValue([{ count: 1 }]);

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).resolves.toBeDefined();
			});

			it("should count the redemptions of this user for the user limit", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsUser: 2 });
				db.on("select", promoCodeRedemptions).mockResolvedValue([{ count: 0 }]);

				await service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" }));

				expect(whereParams(db.ran("select", promoCodeRedemptions)[0])).toEqual([PROMO_ID, USER_ID]);
			});

			it("should check the global limit before the user limit when both are set", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsGlobal: 10, maxRedemptionsUser: 1 });
				db.on("select", promoCodeRedemptions)
					.mockResolvedValueOnce([{ count: 0 }])
					.mockResolvedValueOnce([{ count: 1 }]);

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).rejects.toThrow("Code is already taken");
				expect(db.ran("select", promoCodeRedemptions)).toHaveLength(2);
			});

			// GAP: a per-user limit of 0 is treated as "no limit" (falsy check), while
			// a global limit of 0 blocks everyone.
			it("should throw BadRequestException when the user limit is zero", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsUser: 0 });
				db.on("select", promoCodeRedemptions).mockResolvedValue([{ count: 0 }]);

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).rejects.toThrow(BadRequestException);
			});

			// GAP: redemptions are inserted as PENDING and only APPLIED ones are
			// counted, so people who subscribed but have not paid yet do not use up
			// the global limit and the code can be over-redeemed.
			it("should count PENDING redemptions toward the global limit", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsGlobal: 1 });
				db.on("select", promoCodeRedemptions).mockResolvedValue([{ count: 0 }]);

				await service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" }));

				expect(whereParams(db.ran("select", promoCodeRedemptions)[0])).not.toEqual([
					PROMO_ID,
					"APPLIED",
				]);
			});

			it("should record a PENDING redemption linked to the new subscription", async () => {
				arrangeHappyPath();
				arrangePromo({ discountType: "FIXED", discountValue: 500, durationInCicle: 2 });

				await service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" }));

				const [redemption] = db.ran("insert", promoCodeRedemptions);
				expect(redemption?.values).toEqual({
					discountValue: 500,
					durationInCicle: 2,
					promoCodeId: PROMO_ID,
					userId: USER_ID,
					discountType: "FIXED",
					subscriptionId: SUBSCRIPTION_ID,
					status: "PENDING",
				});
			});

			// GAP: the promo code is validated and recorded, but Asaas is charged the
			// full plan price.
			it("should charge the discounted value when a percentage code is applied", async () => {
				arrangeHappyPath();
				arrangePromo({ discountType: "PERCENTAGE", discountValue: 10 });

				await service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" }));

				expect(payment.createSubscription).toHaveBeenCalledWith(
					expect.objectContaining({ value: 26.91 }),
				);
			});

			it("should reject without writing anything when the promo lookup fails", async () => {
				arrangeHappyPath();
				db.on("select", promoCodesTable).mockRejectedValue(new Error("connection terminated"));

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).rejects.toThrow("connection terminated");
				expectNothingWritten();
			});

			// GAP: the redemption insert runs outside the try/catch, so when it fails
			// the PENDING subscription stays behind and every retry gets a 409.
			it("should remove the pending subscription when recording the redemption fails", async () => {
				arrangeHappyPath();
				arrangePromo();
				db.on("insert", promoCodeRedemptions).mockRejectedValue(new Error("connection terminated"));

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).rejects.toThrow("connection terminated");

				expect(db.ran("delete", subscriptionTable)).toHaveLength(1);
			});

			it("should not call Asaas when recording the redemption fails", async () => {
				arrangeHappyPath();
				arrangePromo();
				db.on("insert", promoCodeRedemptions).mockRejectedValue(new Error("connection terminated"));

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).rejects.toThrow();

				expect(payment.createCustomer).not.toHaveBeenCalled();
				expect(payment.createSubscription).not.toHaveBeenCalled();
			});
		});

		describe("plan", () => {
			it("should throw BadRequestException when the plan does not exist", async () => {
				arrangeHappyPath();
				db.on("select", planTable).mockResolvedValue([]);

				const act = service.createSubscription(buildUser(), buildPayload());

				await expect(act).rejects.toThrow(BadRequestException);
				await expect(act).rejects.toThrow("Cannot subscribe to this plan");
				expectNothingWritten();
			});

			it("should throw BadRequestException when the plan is inactive", async () => {
				arrangeHappyPath();
				db.on("select", planTable).mockResolvedValue([buildPlan({ is_active: false })]);

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					BadRequestException,
				);
				expectNothingWritten();
			});

			// GAP: is_active is nullable and only `=== false` is rejected, so a plan
			// that listPlans hides (is_active null) can still be subscribed to.
			it("should throw BadRequestException when the plan has is_active null", async () => {
				arrangeHappyPath();
				db.on("select", planTable).mockResolvedValue([buildPlan({ is_active: null })]);

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					BadRequestException,
				);
			});

			it("should look the plan up by the planId that was sent", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				expect(whereParams(db.ran("select", planTable)[0])).toEqual([PLAN_ID]);
			});

			it.each([
				["WEEKLY", "WEEKLY"],
				["MONTHLY", "MONTHLY"],
				["MONTLY", "MONTHLY"],
				["monthly", "MONTHLY"],
				["Yearly", "YEARLY"],
				["QUARTERLY", "QUARTERLY"],
				["SEMIANNUALLY", "SEMIANNUALLY"],
			])("should bill the %s interval with the %s cycle", async (billing_interval, cycle) => {
				arrangeHappyPath();
				db.on("select", planTable).mockResolvedValue([buildPlan({ billing_interval })]);

				await service.createSubscription(buildUser(), buildPayload());

				expect(payment.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ cycle }));
			});

			it.each(["DAILY", "", " MONTHLY ", "BIWEEKLY", "month"])(
				"should throw InternalServerErrorException when the plan interval is '%s'",
				async (billing_interval) => {
					arrangeHappyPath();
					db.on("select", planTable).mockResolvedValue([buildPlan({ billing_interval })]);

					await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
						InternalServerErrorException,
					);
					expectNothingWritten();
				},
			);

			it.each([
				[2990, 29.9],
				[1999, 19.99],
				[100, 1],
				[1, 0.01],
				[10000, 100],
			])("should charge %i cents as %d on Asaas", async (price, value) => {
				arrangeHappyPath();
				db.on("select", planTable).mockResolvedValue([buildPlan({ price })]);

				await service.createSubscription(buildUser(), buildPayload());

				expect(payment.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ value }));
			});

			// GAP: nothing stops a free or negative plan from being sent to Asaas.
			it.each([0, -100])("should not call Asaas when the plan price is %i", async (price) => {
				arrangeHappyPath();
				db.on("select", planTable).mockResolvedValue([buildPlan({ price })]);

				await service.createSubscription(buildUser(), buildPayload()).catch(() => undefined);

				expect(payment.createSubscription).not.toHaveBeenCalled();
			});
		});

		describe("existing subscription", () => {
			it.each(["PENDING", "ACTIVE", "EXPIRED", "INACTIVE"] as const)(
				"should throw ConflictException when the user already has a %s subscription to the plan",
				async (status) => {
					arrangeHappyPath();
					db.on("select", subscriptionTable).mockResolvedValue([buildSubscriptionRow({ status })]);

					const act = service.createSubscription(buildUser(), buildPayload());

					await expect(act).rejects.toThrow(ConflictException);
					await expect(act).rejects.toThrow("Subscription already exists");
					expectNothingWritten();
				},
			);

			it("should look for a subscription of the same user to the same plan", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				expect(whereParams(db.ran("select", subscriptionTable)[0])).toEqual([PLAN_ID, USER_ID]);
			});

			it("should not record a redemption when the user is already subscribed", async () => {
				arrangeHappyPath();
				arrangePromo();
				db.on("select", subscriptionTable).mockResolvedValue([buildSubscriptionRow()]);

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).rejects.toThrow(ConflictException);
				expect(db.ran("insert", promoCodeRedemptions)).toHaveLength(0);
			});
		});

		describe("happy path", () => {
			it("should insert the local subscription as PENDING for the user and plan", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				const [insert] = db.ran("insert", subscriptionTable);
				expect(insert?.values).toEqual({ plan_id: PLAN_ID, user_id: USER_ID, status: "PENDING" });
				expect(insert?.returning).toBe(true);
			});

			it("should create the Asaas customer from the body and the stored user", async () => {
				arrangeHappyPath();
				db.on("select", userTable).mockResolvedValue([buildUser({ email: "stored@example.com" })]);

				await service.createSubscription(
					buildUser({ email: "session@example.com" }),
					buildPayload({ fullName: "Fake Full Name", cpf: "529.982.247-25" }),
				);

				expect(payment.createCustomer).toHaveBeenCalledTimes(1);
				expect(payment.createCustomer).toHaveBeenCalledWith({
					name: "Fake Full Name",
					cpfCnpj: "529.982.247-25",
					email: "stored@example.com",
					externalReference: USER_ID,
				});
			});

			it("should store the Asaas customer id on the local subscription", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				const [update] = db.ran("update", subscriptionTable);
				expect(update?.set).toEqual({ customerId: "cus_fake_1" });
				expect(whereParams(update)).toEqual([SUBSCRIPTION_ID]);
			});

			it("should create the Asaas subscription for the customer with today's due date", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload({ paymentMethod: "PIX" }));

				expect(payment.createSubscription).toHaveBeenCalledTimes(1);
				expect(payment.createSubscription).toHaveBeenCalledWith({
					customer: "cus_fake_1",
					billingType: "PIX",
					value: 29.9,
					nextDueDate: "2026-11-13",
					cycle: "MONTHLY",
					description: "Pro",
					externalReference: SUBSCRIPTION_ID,
				});
			});

			it.each(["CREDIT_CARD", "PIX"] as const)(
				"should bill with %s when it is the chosen payment method",
				async (paymentMethod) => {
					arrangeHappyPath();

					const result = await service.createSubscription(
						buildUser(),
						buildPayload({ paymentMethod }),
					);

					expect(payment.createSubscription).toHaveBeenCalledWith(
						expect.objectContaining({ billingType: paymentMethod }),
					);
					expect(result.paymentMethod).toBe(paymentMethod);
				},
			);

			it("should store the Asaas subscription id on the local subscription", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				const [, update] = db.ran("update", subscriptionTable);
				expect(update?.set).toEqual({ asaasSubscriptionId: "sub_fake_1" });
				expect(whereParams(update)).toEqual([SUBSCRIPTION_ID]);
			});

			it("should return the subscription with the Asaas ids and the payment url", async () => {
				arrangeHappyPath();

				const result = await service.createSubscription(buildUser(), buildPayload());

				expect(result).toEqual({
					...buildSubscriptionRow(),
					customerId: "cus_fake_1",
					asaasSubscriptionId: "sub_fake_1",
					paymentMethod: "PIX",
					paymentUrl: "https://sandbox.asaas.example/i/fake_1",
				});
			});

			it("should read the payment url from the payments of the new Asaas subscription", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				expect(payment.listSubscriptionPayments).toHaveBeenCalledWith("sub_fake_1");
			});

			it("should use the first payment when Asaas lists more than one", async () => {
				arrangeHappyPath();
				payment.listSubscriptionPayments.mockResolvedValue([
					buildAsaasPayment({ invoiceUrl: "https://sandbox.asaas.example/i/first" }),
					buildAsaasPayment({ invoiceUrl: "https://sandbox.asaas.example/i/second" }),
				]);

				const result = await service.createSubscription(buildUser(), buildPayload());

				expect(result.paymentUrl).toBe("https://sandbox.asaas.example/i/first");
			});

			it("should not delete anything when the flow succeeds", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				expect(db.ran("delete", subscriptionTable)).toHaveLength(0);
				expect(db.ran("delete", promoCodeRedemptions)).toHaveLength(0);
			});

			it("should write the local intent before calling Asaas and keep the documented order", async () => {
				arrangeHappyPath();
				const steps: string[] = [];
				db.on("insert", subscriptionTable).mockImplementation(async () => {
					steps.push("insert local subscription");
					return [buildSubscriptionRow()];
				});
				db.on("update", subscriptionTable).mockImplementation(async (query) => {
					steps.push(`update local ${Object.keys(query.set as object).join(",")}`);
					return [];
				});
				payment.createCustomer.mockImplementation(async () => {
					steps.push("asaas customer");
					return buildAsaasCustomer();
				});
				payment.createSubscription.mockImplementation(async () => {
					steps.push("asaas subscription");
					return buildAsaasSubscription();
				});

				await service.createSubscription(buildUser(), buildPayload());

				expect(steps).toEqual([
					"insert local subscription",
					"asaas customer",
					"update local customerId",
					"asaas subscription",
					"update local asaasSubscriptionId",
				]);
			});

			it("should use the UTC date as due date late in the Brazilian evening", async () => {
				arrangeHappyPath();
				// 22:30 on Nov 13 in Sao Paulo (UTC-3) is already Nov 14 in UTC.
				vi.setSystemTime(new Date("2026-11-14T01:30:00.000Z"));

				await service.createSubscription(buildUser(), buildPayload());

				expect(payment.createSubscription).toHaveBeenCalledWith(
					expect.objectContaining({ nextDueDate: "2026-11-14" }),
				);
			});
		});

		describe("Asaas customer reuse", () => {
			it("should reuse the customer id of a previous subscription instead of creating one", async () => {
				arrangeHappyPath();
				db.on("select", subscriptionTable)
					.mockResolvedValueOnce([])
					.mockResolvedValueOnce([{ customerId: "cus_existing" }]);

				const result = await service.createSubscription(buildUser(), buildPayload());

				expect(payment.createCustomer).not.toHaveBeenCalled();
				expect(payment.createSubscription).toHaveBeenCalledWith(
					expect.objectContaining({ customer: "cus_existing" }),
				);
				expect(result.customerId).toBe("cus_existing");
			});

			it("should look for a previous customer id among the subscriptions of the user", async () => {
				arrangeHappyPath();

				await service.createSubscription(buildUser(), buildPayload());

				const [, lookup] = db.ran("select", subscriptionTable);
				expect(whereParams(lookup)).toEqual([USER_ID]);
				expect(lookup?.limit).toBe(1);
			});

			it.each([
				["has a null customer id", [{ customerId: null }]],
				["has an empty customer id", [{ customerId: "" }]],
				["is missing", []],
			])("should create a customer when the previous subscription %s", async (_label, rows) => {
				arrangeHappyPath();
				db.on("select", subscriptionTable).mockResolvedValueOnce([]).mockResolvedValueOnce(rows);

				await service.createSubscription(buildUser(), buildPayload());

				expect(payment.createCustomer).toHaveBeenCalledTimes(1);
			});
		});

		describe("payment url", () => {
			it("should return a null payment url when Asaas lists no payment yet", async () => {
				arrangeHappyPath();
				payment.listSubscriptionPayments.mockResolvedValue([]);

				const result = await service.createSubscription(buildUser(), buildPayload());

				expect(result.paymentUrl).toBeNull();
			});

			it("should return a null payment url when the first payment has no invoice url", async () => {
				arrangeHappyPath();
				payment.listSubscriptionPayments.mockResolvedValue([
					{ ...buildAsaasPayment(), invoiceUrl: undefined } as unknown as AsaasPayment,
				]);

				const result = await service.createSubscription(buildUser(), buildPayload());

				expect(result.paymentUrl).toBeNull();
			});

			it("should keep the subscription and return a null payment url when listing payments fails", async () => {
				arrangeHappyPath();
				payment.listSubscriptionPayments.mockRejectedValue(
					new ServiceUnavailableException("Payment provider unavailable"),
				);

				const result = await service.createSubscription(buildUser(), buildPayload());

				expect(result.paymentUrl).toBeNull();
				expect(result.asaasSubscriptionId).toBe("sub_fake_1");
				expect(db.ran("delete", subscriptionTable)).toHaveLength(0);
				expect(db.ran("delete", promoCodeRedemptions)).toHaveLength(0);
			});
		});

		describe("Asaas failures", () => {
			it.each([
				["rejects the CPF", new BadRequestException("Invalid CPF")],
				["is down", new ServiceUnavailableException("Payment provider unavailable")],
				["answers an error", new BadGatewayException("Payment provider error")],
			])(
				"should drop the local intent and rethrow when Asaas %s on customer creation",
				async (_l, failure) => {
					arrangeHappyPath();
					arrangePromo();
					payment.createCustomer.mockRejectedValue(failure);

					await expect(
						service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
					).rejects.toBe(failure);

					expect(whereParams(db.ran("delete", promoCodeRedemptions)[0])).toEqual([SUBSCRIPTION_ID]);
					expect(whereParams(db.ran("delete", subscriptionTable)[0])).toEqual([SUBSCRIPTION_ID]);
					expect(payment.createSubscription).not.toHaveBeenCalled();
				},
			);

			it("should delete the redemption before the subscription it references", async () => {
				arrangeHappyPath();
				payment.createCustomer.mockRejectedValue(new BadRequestException("Invalid CPF"));

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow();

				const deletes = db.queries.filter((query) => query.operation === "delete");
				expect(deletes.map((query) => query.table)).toEqual([
					getTableName(promoCodeRedemptions),
					getTableName(subscriptionTable),
				]);
			});

			it("should not store a customer id when customer creation fails", async () => {
				arrangeHappyPath();
				payment.createCustomer.mockRejectedValue(new BadRequestException("Invalid CPF"));

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow();

				expect(db.ran("update", subscriptionTable)).toHaveLength(0);
			});

			it.each([
				["rejects the data", new BadRequestException("Invalid customer")],
				["answers an error", new BadGatewayException("Payment provider error")],
			])(
				"should drop the local intent and rethrow when Asaas %s on subscription creation",
				async (_l, failure) => {
					arrangeHappyPath();
					payment.createSubscription.mockRejectedValue(failure);

					await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toBe(
						failure,
					);

					expect(db.ran("delete", promoCodeRedemptions)).toHaveLength(1);
					expect(db.ran("delete", subscriptionTable)).toHaveLength(1);
					expect(payment.listSubscriptionPayments).not.toHaveBeenCalled();
				},
			);

			// GAP: a timeout on subscription creation does not mean Asaas did not
			// create it. Deleting the local row then leaves a billable subscription
			// on Asaas that nothing local points to.
			it("should keep the local subscription when Asaas subscription creation times out", async () => {
				arrangeHappyPath();
				payment.createSubscription.mockRejectedValue(
					new ServiceUnavailableException("Payment provider unavailable"),
				);

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					ServiceUnavailableException,
				);

				expect(db.ran("delete", subscriptionTable)).toHaveLength(0);
			});

			// GAP: the customer id only lives on the subscription row that the
			// cleanup deletes, so the retry creates a second customer on Asaas.
			it("should reuse the Asaas customer on the retry after subscription creation failed", async () => {
				arrangeHappyPath();
				const stored: { customerId: string | null }[] = [];
				db.on("update", subscriptionTable).mockImplementation(async (query) => {
					const set = query.set as { customerId?: string };
					if (set.customerId) stored.push({ customerId: set.customerId });
					return [];
				});
				db.on("delete", subscriptionTable).mockImplementation(async () => {
					stored.length = 0;
					return [];
				});
				db.on("select", subscriptionTable).mockImplementation(async (query) =>
					query.limit === 1 ? [...stored] : [],
				);
				payment.createSubscription
					.mockRejectedValueOnce(new BadGatewayException("Payment provider error"))
					.mockResolvedValueOnce(buildAsaasSubscription());

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow();
				await service.createSubscription(buildUser(), buildPayload());

				expect(payment.createCustomer).toHaveBeenCalledTimes(1);
			});
		});

		describe("database failures", () => {
			it("should not call Asaas when inserting the local subscription fails", async () => {
				arrangeHappyPath();
				db.on("insert", subscriptionTable).mockRejectedValue(new Error("connection terminated"));

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					"connection terminated",
				);

				expect(payment.createCustomer).not.toHaveBeenCalled();
				expect(payment.createSubscription).not.toHaveBeenCalled();
			});

			it("should reject without writing anything when the plan lookup fails", async () => {
				arrangeHappyPath();
				db.on("select", planTable).mockRejectedValue(new Error("connection terminated"));

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					"connection terminated",
				);
				expectNothingWritten();
			});

			it("should reject without writing anything when the existing subscription check fails", async () => {
				arrangeHappyPath();
				db.on("select", subscriptionTable).mockRejectedValue(new Error("connection terminated"));

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					"connection terminated",
				);
				expectNothingWritten();
			});

			it("should drop the local intent when the previous customer lookup fails", async () => {
				arrangeHappyPath();
				const failure = new Error("connection terminated");
				db.on("select", subscriptionTable).mockResolvedValueOnce([]).mockRejectedValueOnce(failure);

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toBe(failure);

				expect(db.ran("delete", subscriptionTable)).toHaveLength(1);
				expect(payment.createCustomer).not.toHaveBeenCalled();
			});

			it("should not create the Asaas subscription when storing the customer id fails", async () => {
				arrangeHappyPath();
				const failure = new Error("connection terminated");
				db.on("update", subscriptionTable).mockRejectedValueOnce(failure);

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toBe(failure);

				expect(payment.createSubscription).not.toHaveBeenCalled();
				expect(db.ran("delete", subscriptionTable)).toHaveLength(1);
			});

			// GAP: this is the orphan. Asaas already created the subscription (and
			// will bill it), then saving its id fails and the catch block deletes
			// the only local row that pointed to it.
			it("should keep the local subscription when storing the Asaas subscription id fails", async () => {
				arrangeHappyPath();
				db.on("update", subscriptionTable)
					.mockResolvedValueOnce([])
					.mockRejectedValueOnce(new Error("connection terminated"));

				await service.createSubscription(buildUser(), buildPayload()).catch(() => undefined);

				expect(payment.createSubscription).toHaveBeenCalledTimes(1);
				expect(db.ran("delete", subscriptionTable)).toHaveLength(0);
			});

			// GAP: same orphan seen from the redemption side.
			it("should keep the redemption when storing the Asaas subscription id fails", async () => {
				arrangeHappyPath();
				arrangePromo();
				db.on("update", subscriptionTable)
					.mockResolvedValueOnce([])
					.mockRejectedValueOnce(new Error("connection terminated"));

				await service
					.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" }))
					.catch(() => undefined);

				expect(db.ran("delete", promoCodeRedemptions)).toHaveLength(0);
			});

			// GAP: when the cleanup itself fails, its error replaces the Asaas error
			// the user should see.
			it("should rethrow the Asaas error when deleting the redemption fails during cleanup", async () => {
				arrangeHappyPath();
				const asaasFailure = new BadRequestException("Invalid CPF");
				payment.createCustomer.mockRejectedValue(asaasFailure);
				db.on("delete", promoCodeRedemptions).mockRejectedValue(new Error("connection terminated"));

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toBe(
					asaasFailure,
				);
			});

			// GAP: if the first cleanup delete fails, the second one never runs and
			// the PENDING subscription blocks every retry with a 409.
			it("should still delete the pending subscription when deleting the redemption fails", async () => {
				arrangeHappyPath();
				payment.createCustomer.mockRejectedValue(new BadRequestException("Invalid CPF"));
				db.on("delete", promoCodeRedemptions).mockRejectedValue(new Error("connection terminated"));

				await service.createSubscription(buildUser(), buildPayload()).catch(() => undefined);

				expect(db.ran("delete", subscriptionTable)).toHaveLength(1);
			});

			// GAP: same masking when the subscription delete is the one that fails.
			it("should rethrow the Asaas error when deleting the subscription fails during cleanup", async () => {
				arrangeHappyPath();
				const asaasFailure = new BadGatewayException("Payment provider error");
				payment.createSubscription.mockRejectedValue(asaasFailure);
				db.on("delete", subscriptionTable).mockRejectedValue(new Error("connection terminated"));

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toBe(
					asaasFailure,
				);
			});
		});

		describe("null objects", () => {
			// GAP: when the insert returns no row, the flow still reaches Asaas and
			// creates a customer before crashing on `newSubscription.id`.
			it("should not create an Asaas customer when the insert returns no row", async () => {
				arrangeHappyPath();
				db.on("insert", subscriptionTable).mockResolvedValue([]);

				await service.createSubscription(buildUser(), buildPayload()).catch(() => undefined);

				expect(payment.createCustomer).not.toHaveBeenCalled();
			});

			it("should reject when the insert returns no row", async () => {
				arrangeHappyPath();
				db.on("insert", subscriptionTable).mockResolvedValue([]);

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow();
				expect(payment.createSubscription).not.toHaveBeenCalled();
			});

			// GAP: a customer without an id is stored and billed as `undefined`.
			it.each([
				["has no id", { ...buildAsaasCustomer(), id: undefined }],
				["is null", null],
			])(
				"should not create the Asaas subscription when the Asaas customer %s",
				async (_l, customer) => {
					arrangeHappyPath();
					payment.createCustomer.mockResolvedValue(customer as unknown as AsaasCustomer);

					await service.createSubscription(buildUser(), buildPayload()).catch(() => undefined);

					expect(payment.createSubscription).not.toHaveBeenCalled();
				},
			);

			// GAP: a subscription without an id is "stored" as undefined and reported
			// to the client as a success.
			it("should reject when the Asaas subscription has no id", async () => {
				arrangeHappyPath();
				payment.createSubscription.mockResolvedValue({
					...buildAsaasSubscription(),
					id: undefined,
				} as unknown as AsaasSubscription);

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow();
			});

			it("should reject when the redemption count query returns no row", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsGlobal: 5 });
				db.on("select", promoCodeRedemptions).mockResolvedValue([]);

				await expect(
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
				).rejects.toThrow();
				expectNothingWritten();
			});
		});

		describe("race conditions", () => {
			/** Makes the fake subscriptions table remember what was inserted. */
			const arrangeStatefulSubscriptions = () => {
				const rows: SubscriptionRow[] = [];
				db.on("select", subscriptionTable).mockImplementation(async (query) =>
					query.limit === 1 ? rows.filter((row) => row.customerId !== null) : [...rows],
				);
				db.on("insert", subscriptionTable).mockImplementation(async () => {
					const row = buildSubscriptionRow({
						id: `cccccccc-cccc-4ccc-8ccc-00000000000${rows.length}`,
					});
					rows.push(row);
					return [row];
				});
				return rows;
			};

			it("should throw ConflictException on a second request made after the first one finished", async () => {
				arrangeHappyPath();
				arrangeStatefulSubscriptions();

				await service.createSubscription(buildUser(), buildPayload());

				await expect(service.createSubscription(buildUser(), buildPayload())).rejects.toThrow(
					ConflictException,
				);
				expect(payment.createSubscription).toHaveBeenCalledTimes(1);
			});

			// GAP: "check then insert" with no lock or unique constraint. Two requests
			// sent at the same time (double click) both pass the check, so the user
			// ends up with two local subscriptions and is billed twice on Asaas.
			it("should create a single Asaas subscription when two requests run at the same time", async () => {
				arrangeHappyPath();
				arrangeStatefulSubscriptions();

				await Promise.allSettled([
					service.createSubscription(buildUser(), buildPayload()),
					service.createSubscription(buildUser(), buildPayload()),
				]);

				expect(payment.createSubscription).toHaveBeenCalledTimes(1);
			});

			// GAP: same race, seen from the local table.
			it("should insert a single local subscription when two requests run at the same time", async () => {
				arrangeHappyPath();
				const rows = arrangeStatefulSubscriptions();

				await Promise.allSettled([
					service.createSubscription(buildUser(), buildPayload()),
					service.createSubscription(buildUser(), buildPayload()),
				]);

				expect(rows).toHaveLength(1);
			});

			// GAP: same race on the customer: both requests see "no previous
			// customer" and each one creates its own on Asaas.
			it("should create a single Asaas customer when two requests run at the same time", async () => {
				arrangeHappyPath();
				arrangeStatefulSubscriptions();

				await Promise.allSettled([
					service.createSubscription(buildUser(), buildPayload()),
					service.createSubscription(buildUser(), buildPayload({ planId: PROMO_ID })),
				]);

				expect(payment.createCustomer).toHaveBeenCalledTimes(1);
			});

			// GAP: the redemption limit is also "count then insert": two users can
			// take the last redemption of a code at the same time.
			it("should let only one of two simultaneous requests take the last redemption", async () => {
				arrangeHappyPath();
				arrangePromo({ maxRedemptionsGlobal: 1 });
				let redeemed = 0;
				db.on("select", promoCodeRedemptions).mockImplementation(async () => [{ count: redeemed }]);
				db.on("insert", promoCodeRedemptions).mockImplementation(async () => {
					redeemed += 1;
					return [];
				});

				const results = await Promise.allSettled([
					service.createSubscription(buildUser(), buildPayload({ discountCode: "FAKE10" })),
					service.createSubscription(
						buildUser({ id: PROMO_ID }),
						buildPayload({ discountCode: "FAKE10" }),
					),
				]);

				expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			});

			// GAP: the payment webhook can activate the subscription while this
			// request is still running. If a later step then fails, the cleanup
			// deletes a subscription the user has already paid for.
			it("should not delete a subscription that was paid while the request was still running", async () => {
				arrangeHappyPath();
				let status: SubscriptionRow["status"] = "PENDING";
				payment.createSubscription.mockImplementation(async () => {
					status = "ACTIVE"; // webhook delivered right after Asaas created it
					return buildAsaasSubscription();
				});
				db.on("update", subscriptionTable)
					.mockResolvedValueOnce([])
					.mockRejectedValueOnce(new Error("connection terminated"));

				await service.createSubscription(buildUser(), buildPayload()).catch(() => undefined);

				expect(status).toBe("ACTIVE");
				expect(db.ran("delete", subscriptionTable)).toHaveLength(0);
			});
		});
	});

	describe("activateFromPayment", () => {
		const arrangeActivation = (plan: PlanRow | undefined = buildPlan()) => {
			db.on("update", subscriptionTable).mockResolvedValue([
				buildSubscriptionRow({ status: "ACTIVE" }),
			]);
			db.on("select", planTable).mockResolvedValue(plan ? [plan] : []);
		};

		it.each([
			["null", null],
			["undefined", undefined],
			["an empty string", ""],
			["a numeric reference", "056984"],
			["an Asaas subscription id", "sub_fake_1"],
			["a uuid with a trailing space", `${SUBSCRIPTION_ID} `],
			["a uuid followed by sql", `${SUBSCRIPTION_ID}' OR 1=1 --`],
			["a uuid without dashes", SUBSCRIPTION_ID.replaceAll("-", "")],
		])("should return false without touching the database when given %s", async (_l, reference) => {
			arrangeActivation();

			await expect(service.activateFromPayment(reference)).resolves.toBe(false);

			expect(db.transaction).not.toHaveBeenCalled();
			expect(db.queries).toHaveLength(0);
		});

		it("should activate the PENDING subscription and return true", async () => {
			arrangeActivation();

			await expect(service.activateFromPayment(SUBSCRIPTION_ID)).resolves.toBe(true);

			const [update] = db.ran("update", subscriptionTable);
			expect(update?.set).toEqual({ status: "ACTIVE" });
			expect(whereParams(update)).toEqual([SUBSCRIPTION_ID, "PENDING"]);
		});

		it("should accept an uppercase uuid", async () => {
			arrangeActivation();

			await expect(service.activateFromPayment(SUBSCRIPTION_ID.toUpperCase())).resolves.toBe(true);
		});

		it("should move the user to the plan and restart the usage cycle now", async () => {
			arrangeActivation();

			await service.activateFromPayment(SUBSCRIPTION_ID);

			const [update] = db.ran("update", userTable);
			expect(update?.set).toEqual({ plan: "PRO", cycleAnchorAt: NOW });
			expect(whereParams(update)).toEqual([USER_ID]);
		});

		it("should read the plan of the activated subscription", async () => {
			arrangeActivation();

			await service.activateFromPayment(SUBSCRIPTION_ID);

			expect(whereParams(db.ran("select", planTable)[0])).toEqual([PLAN_ID]);
		});

		it("should run every write inside one transaction", async () => {
			arrangeActivation();

			await service.activateFromPayment(SUBSCRIPTION_ID);

			expect(db.transaction).toHaveBeenCalledTimes(1);
			expect(db.queries.length).toBeGreaterThan(0);
			expect(db.queries.every((query) => query.inTransaction)).toBe(true);
		});

		it.each([
			["Pro", "PRO"],
			["pro", "PRO"],
			["PRO", "PRO"],
			["Free", "FREE"],
		])("should map the plan named '%s' to the %s user plan", async (name, plan) => {
			arrangeActivation(buildPlan({ name }));

			await service.activateFromPayment(SUBSCRIPTION_ID);

			expect(db.ran("update", userTable)[0]?.set).toMatchObject({ plan });
		});

		it.each([
			["there is no PENDING subscription with that id", []],
			["the subscription was already activated", []],
		])("should return false and leave the user untouched when %s", async (_label, rows) => {
			arrangeActivation();
			db.on("update", subscriptionTable).mockResolvedValue(rows);

			await expect(service.activateFromPayment(SUBSCRIPTION_ID)).resolves.toBe(false);

			expect(db.ran("select", planTable)).toHaveLength(0);
			expect(db.ran("update", userTable)).toHaveLength(0);
		});

		// GAP: the subscription becomes ACTIVE but the user silently stays on the
		// old plan when the plan name is not one of the user plan enum values
		// ("Pro Anual", "Enterprise", " Pro").
		it.each(["Enterprise", "Pro Anual", " Pro", ""])(
			"should not report an activation when the plan named '%s' maps to no user plan",
			async (name) => {
				arrangeActivation(buildPlan({ name }));

				const result = await service.activateFromPayment(SUBSCRIPTION_ID).catch(() => "rejected");

				expect(result).not.toBe(true);
			},
		);

		// GAP: same silent half-activation when the plan row is gone.
		it("should not report an activation when the plan of the subscription no longer exists", async () => {
			arrangeActivation(undefined);

			const result = await service.activateFromPayment(SUBSCRIPTION_ID).catch(() => "rejected");

			expect(result).not.toBe(true);
		});

		it("should not update the user when the plan maps to no user plan", async () => {
			arrangeActivation(buildPlan({ name: "Enterprise" }));

			await service.activateFromPayment(SUBSCRIPTION_ID).catch(() => undefined);

			expect(db.ran("update", userTable)).toHaveLength(0);
		});

		// GAP: paying never marks the promo redemption as APPLIED, so redemptions
		// stay PENDING forever and the global limit never counts them.
		it("should mark the promo redemption of the subscription as APPLIED", async () => {
			arrangeActivation();

			await service.activateFromPayment(SUBSCRIPTION_ID);

			const [update] = db.ran("update", promoCodeRedemptions);
			expect(update?.set).toMatchObject({ status: "APPLIED" });
		});

		// GAP: subscribedAt is set when the intent is created, not when it is paid.
		it("should set subscribedAt to the activation time", async () => {
			arrangeActivation();

			await service.activateFromPayment(SUBSCRIPTION_ID);

			expect(db.ran("update", subscriptionTable)[0]?.set).toMatchObject({ subscribedAt: NOW });
		});

		it("should reject so the transaction rolls back when updating the user fails", async () => {
			arrangeActivation();
			const failure = new Error("connection terminated");
			db.on("update", userTable).mockRejectedValue(failure);

			await expect(service.activateFromPayment(SUBSCRIPTION_ID)).rejects.toBe(failure);

			await expect(db.transaction.mock.results[0]?.value).rejects.toBe(failure);
		});

		it("should reject so the transaction rolls back when reading the plan fails", async () => {
			arrangeActivation();
			const failure = new Error("connection terminated");
			db.on("select", planTable).mockRejectedValue(failure);

			await expect(service.activateFromPayment(SUBSCRIPTION_ID)).rejects.toBe(failure);

			expect(db.ran("update", userTable)).toHaveLength(0);
		});

		it("should reject when activating the subscription fails", async () => {
			arrangeActivation();
			const failure = new Error("connection terminated");
			db.on("update", subscriptionTable).mockRejectedValue(failure);

			await expect(service.activateFromPayment(SUBSCRIPTION_ID)).rejects.toBe(failure);

			expect(db.ran("update", userTable)).toHaveLength(0);
		});

		it("should reject when the transaction cannot be opened", async () => {
			const failure = new Error("too many clients");
			db.transaction.mockRejectedValue(failure);

			await expect(service.activateFromPayment(SUBSCRIPTION_ID)).rejects.toBe(failure);

			expect(db.queries).toHaveLength(0);
		});

		it("should reject when the transaction fails to commit", async () => {
			arrangeActivation();
			const failure = new Error("commit failed");
			db.transaction.mockImplementation(async (callback) => {
				await callback(db);
				throw failure;
			});

			await expect(service.activateFromPayment(SUBSCRIPTION_ID)).rejects.toBe(failure);
		});

		it("should activate only once when the same payment is delivered twice at the same time", async () => {
			arrangeActivation();
			db.on("update", subscriptionTable)
				.mockResolvedValueOnce([buildSubscriptionRow({ status: "ACTIVE" })])
				.mockResolvedValueOnce([]);

			const results = await Promise.all([
				service.activateFromPayment(SUBSCRIPTION_ID),
				service.activateFromPayment(SUBSCRIPTION_ID),
			]);

			expect(results.toSorted()).toEqual([false, true]);
			expect(db.ran("update", userTable)).toHaveLength(1);
		});

		it("should not restart the usage cycle when a later payment of an active subscription arrives", async () => {
			arrangeActivation();
			db.on("update", subscriptionTable).mockResolvedValue([]);

			await service.activateFromPayment(SUBSCRIPTION_ID);

			expect(db.ran("update", userTable)).toHaveLength(0);
		});

		it("should activate each subscription independently when two payments arrive together", async () => {
			const otherId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
			arrangeActivation();
			db.on("update", subscriptionTable).mockImplementation(async (query) => [
				buildSubscriptionRow({ id: String(whereParams(query)[0]), status: "ACTIVE" }),
			]);

			const results = await Promise.all([
				service.activateFromPayment(SUBSCRIPTION_ID),
				service.activateFromPayment(otherId),
			]);

			expect(results).toEqual([true, true]);
			expect(db.transaction).toHaveBeenCalledTimes(2);
		});
	});

	describe("listPlans", () => {
		it("should return the active plans", async () => {
			const plans = [buildPlan(), buildPlan({ id: PROMO_ID, name: "Free", price: 0 })];
			db.on("select", planTable).mockResolvedValue(plans);

			await expect(service.listPlans()).resolves.toEqual(plans);
		});

		it("should filter by is_active true", async () => {
			await service.listPlans();

			const [query] = db.ran("select", planTable);
			expect(whereParams(query)).toEqual([true]);
		});

		it("should return an empty array when there is no active plan", async () => {
			db.on("select", planTable).mockResolvedValue([]);

			await expect(service.listPlans()).resolves.toEqual([]);
		});

		it("should reject when the query fails", async () => {
			db.on("select", planTable).mockRejectedValue(new Error("connection terminated"));

			await expect(service.listPlans()).rejects.toThrow("connection terminated");
		});

		it("should not call Asaas", async () => {
			await service.listPlans();

			expect(payment.createCustomer).not.toHaveBeenCalled();
			expect(payment.createSubscription).not.toHaveBeenCalled();
			expect(payment.listSubscriptionPayments).not.toHaveBeenCalled();
		});
	});
});
