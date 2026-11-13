import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MockedFunction } from "vitest";
import type { User } from "../db/schemas/user.js";
import type { SubscribeDTO } from "./dto/create-subscription.dto.js";
import { SubscriptionController } from "./subscription.controller.js";
import { SubscriptionService } from "./subscription.service.js";

type SubscribeResult = Awaited<ReturnType<SubscriptionService["createSubscription"]>>;
type PlanList = Awaited<ReturnType<SubscriptionService["listPlans"]>>;

const createSubscriptionServiceMock = () => ({
	createSubscription: vi.fn() as unknown as MockedFunction<
		SubscriptionService["createSubscription"]
	>,
	listPlans: vi.fn() as unknown as MockedFunction<SubscriptionService["listPlans"]>,
});

const buildUser = (overrides: Partial<User> = {}): User => ({
	id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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

const buildBody = (overrides: Partial<SubscribeDTO> = {}): SubscribeDTO => ({
	planId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	paymentMethod: "PIX",
	fullName: "Fake User Full Name",
	cpf: "529.982.247-25",
	...overrides,
});

const buildSubscribeResult = (): SubscribeResult => ({
	id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	plan_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	status: "PENDING",
	subscribedAt: new Date("2026-11-13T12:00:00.000Z"),
	cancelledAt: null,
	cancelReason: null,
	customerId: "cus_fake_1",
	asaasSubscriptionId: "sub_fake_1",
	paymentMethod: "PIX",
	paymentUrl: "https://sandbox.asaas.example/i/fake_1",
});

const buildPlans = (): PlanList => [
	{
		id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		name: "Pro",
		description: null,
		price: 2990,
		currency: "BRL",
		billing_interval: "MONTHLY",
		is_active: true,
		limits: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	},
];

describe("SubscriptionController", () => {
	let controller: SubscriptionController;
	let subscriptionService: ReturnType<typeof createSubscriptionServiceMock>;

	beforeEach(async () => {
		subscriptionService = createSubscriptionServiceMock();

		const module = await Test.createTestingModule({
			controllers: [SubscriptionController],
			providers: [{ provide: SubscriptionService, useValue: subscriptionService }],
		}).compile();

		controller = module.get(SubscriptionController);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("subscribe", () => {
		it("should delegate to the service with the current user and the body", async () => {
			const user = buildUser();
			const body = buildBody({ paymentMethod: "CREDIT_CARD", discountCode: "FAKE10" });
			subscriptionService.createSubscription.mockResolvedValue(buildSubscribeResult());

			await controller.subscribe(user, body);

			expect(subscriptionService.createSubscription).toHaveBeenCalledTimes(1);
			expect(subscriptionService.createSubscription).toHaveBeenCalledWith(user, body);
		});

		it("should return what the service returns", async () => {
			const result = buildSubscribeResult();
			subscriptionService.createSubscription.mockResolvedValue(result);

			await expect(controller.subscribe(buildUser(), buildBody())).resolves.toBe(result);
		});

		it.each([
			["a conflict", new ConflictException("Subscription already exists")],
			["a validation error from Asaas", new BadRequestException("Invalid CPF")],
			["an unexpected error", new Error("connection terminated")],
		])("should propagate %s thrown by the service", async (_label, failure) => {
			subscriptionService.createSubscription.mockRejectedValue(failure);

			await expect(controller.subscribe(buildUser(), buildBody())).rejects.toBe(failure);
		});

		it("should not list plans", async () => {
			subscriptionService.createSubscription.mockResolvedValue(buildSubscribeResult());

			await controller.subscribe(buildUser(), buildBody());

			expect(subscriptionService.listPlans).not.toHaveBeenCalled();
		});
	});

	describe("getPlans", () => {
		it("should return the plans listed by the service", async () => {
			const plans = buildPlans();
			subscriptionService.listPlans.mockResolvedValue(plans);

			await expect(controller.getPlans()).resolves.toBe(plans);
			expect(subscriptionService.listPlans).toHaveBeenCalledTimes(1);
		});

		it("should return an empty array when there is no plan", async () => {
			subscriptionService.listPlans.mockResolvedValue([]);

			await expect(controller.getPlans()).resolves.toEqual([]);
		});

		it("should propagate the error when the service fails", async () => {
			const failure = new Error("connection terminated");
			subscriptionService.listPlans.mockRejectedValue(failure);

			await expect(controller.getPlans()).rejects.toBe(failure);
		});

		it("should not create a subscription", async () => {
			subscriptionService.listPlans.mockResolvedValue([]);

			await controller.getPlans();

			expect(subscriptionService.createSubscription).not.toHaveBeenCalled();
		});
	});
});
