import {
	BadGatewayException,
	BadRequestException,
	Logger,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { MockedFunction, MockInstance } from "vitest";
import type { AsaasCustomer, CreateAsaasCustomerInput } from "./dto/asaas-customer.dto.js";
import type {
	AsaasPayment,
	AsaasSubscription,
	CreateAsaasSubscriptionInput,
} from "./dto/asaas-subscription.dto.js";
import { PaymentService } from "./payment.service.js";

// Tests marked with "GAP:" describe behavior the service should have but does
// not have yet. They are expected to fail until the source is fixed.

const API_KEY = "$aact_hmlg_fake-key-used-only-in-tests";
const WEBHOOK_TOKEN = "fake-webhook-token-0123456789abcdef";
const SANDBOX_URL = "https://api-sandbox.asaas.com/v3";

type Env = Record<string, string | undefined>;

const createConfigMock = (env: Env) => ({
	get: vi.fn((key: string) => env[key]) as unknown as MockedFunction<ConfigService["get"]>,
	getOrThrow: vi.fn((key: string) => {
		const value = env[key];
		if (value === undefined) throw new Error(`Configuration key "${key}" does not exist`);
		return value;
	}) as unknown as MockedFunction<ConfigService["getOrThrow"]>,
});

const buildService = async (env: Env = {}) => {
	const config = createConfigMock({
		ASAAS_API_KEY: API_KEY,
		ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
		...env,
	});
	const module = await Test.createTestingModule({
		providers: [PaymentService, { provide: ConfigService, useValue: config }],
	}).compile();

	return { service: module.get(PaymentService), config };
};

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const textResponse = (body: string, status = 200) => new Response(body, { status });

const asaasError = (...errors: { code: string; description: string }[]) => ({ errors });

const buildCustomerInput = (
	overrides: Partial<CreateAsaasCustomerInput> = {},
): CreateAsaasCustomerInput => ({
	name: "Fake Person",
	cpfCnpj: "529.982.247-25",
	...overrides,
});

const buildCustomer = (overrides: Partial<AsaasCustomer> = {}): AsaasCustomer => ({
	object: "customer",
	id: "cus_fake_1",
	dateCreated: "2026-11-13",
	name: "Fake Person",
	cpfCnpj: "52998224725",
	personType: "FISICA",
	notificationDisabled: false,
	deleted: false,
	...overrides,
});

const buildSubscriptionInput = (
	overrides: Partial<CreateAsaasSubscriptionInput> = {},
): CreateAsaasSubscriptionInput => ({
	customer: "cus_fake_1",
	billingType: "PIX",
	value: 29.9,
	nextDueDate: "2026-11-13",
	cycle: "MONTHLY",
	description: "Pro",
	externalReference: "11111111-1111-4111-8111-111111111111",
	...overrides,
});

const buildSubscription = (overrides: Partial<AsaasSubscription> = {}): AsaasSubscription => ({
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

const buildPayment = (overrides: Partial<AsaasPayment> = {}): AsaasPayment => ({
	object: "payment",
	id: "pay_fake_1",
	customer: "cus_fake_1",
	subscription: "sub_fake_1",
	externalReference: "11111111-1111-4111-8111-111111111111",
	status: "PENDING",
	billingType: "PIX",
	value: 29.9,
	dueDate: "2026-11-13",
	invoiceUrl: "https://sandbox.asaas.example/i/fake_1",
	...overrides,
});

describe("PaymentService", () => {
	let fetchMock: MockedFunction<typeof fetch>;
	let errorLog: MockInstance<Logger["error"]>;
	let warnLog: MockInstance<Logger["warn"]>;

	const requestOf = (callIndex = 0) => {
		const [url, init] = fetchMock.mock.calls[callIndex] ?? [];
		return {
			url: typeof url === "string" ? url : "",
			init: init ?? {},
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
		};
	};

	const loggedText = () =>
		[...errorLog.mock.calls, ...warnLog.mock.calls].map((call) => call.join(" ")).join("\n");

	beforeEach(() => {
		fetchMock = vi.fn() as unknown as MockedFunction<typeof fetch>;
		vi.stubGlobal("fetch", fetchMock);
		errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
		warnLog = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	describe("constructor", () => {
		it("should fail to build when ASAAS_API_KEY is not configured", async () => {
			await expect(buildService({ ASAAS_API_KEY: undefined })).rejects.toThrow("ASAAS_API_KEY");
		});

		it("should build when ASAAS_WEBHOOK_TOKEN is not configured", async () => {
			const { service } = await buildService({ ASAAS_WEBHOOK_TOKEN: undefined });

			expect(service).toBeInstanceOf(PaymentService);
		});

		it.each([
			["is not set", undefined],
			["is an empty string", ""],
		])("should call the sandbox URL when ASAAS_API_URL %s", async (_label, apiUrl) => {
			const { service } = await buildService({ ASAAS_API_URL: apiUrl });
			fetchMock.mockResolvedValue(jsonResponse(buildCustomer()));

			await service.createCustomer(buildCustomerInput());

			expect(requestOf().url).toBe(`${SANDBOX_URL}/customers`);
		});

		it.each([
			["https://api.asaas.com/v3", "https://api.asaas.com/v3/customers"],
			["https://api.asaas.com/v3/", "https://api.asaas.com/v3/customers"],
			["https://api.asaas.com/v3///", "https://api.asaas.com/v3/customers"],
		])("should call %s without duplicated slashes", async (apiUrl, expectedUrl) => {
			const { service } = await buildService({ ASAAS_API_URL: apiUrl });
			fetchMock.mockResolvedValue(jsonResponse(buildCustomer()));

			await service.createCustomer(buildCustomerInput());

			expect(requestOf().url).toBe(expectedUrl);
		});
	});

	describe("createCustomer", () => {
		it("should POST the customer to Asaas and return the created customer", async () => {
			const { service } = await buildService();
			const customer = buildCustomer();
			fetchMock.mockResolvedValue(jsonResponse(customer));

			const result = await service.createCustomer(buildCustomerInput());

			expect(result).toEqual(customer);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(requestOf().url).toBe(`${SANDBOX_URL}/customers`);
			expect(requestOf().init.method).toBe("POST");
		});

		it("should send the api key, user agent and json headers", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(buildCustomer()));

			await service.createCustomer(buildCustomerInput());

			expect(requestOf().headers).toEqual({
				accept: "application/json",
				"content-type": "application/json",
				"User-Agent": "MATIAS/1.0.0",
				access_token: API_KEY,
			});
		});

		it("should send a timeout signal with the request", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(buildCustomer()));

			await service.createCustomer(buildCustomerInput());

			expect(requestOf().init.signal).toBeInstanceOf(AbortSignal);
		});

		it.each([
			["a punctuated CPF", "529.982.247-25", "52998224725"],
			["a CPF with only digits", "52998224725", "52998224725"],
			["a punctuated CNPJ", "11.222.333/0001-81", "11222333000181"],
			["a CPF with spaces", " 529 982 247 25 ", "52998224725"],
			["a value without digits", "abc", ""],
			["an empty string", "", ""],
		])("should send only the digits of cpfCnpj when given %s", async (_label, input, sent) => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(buildCustomer()));

			await service.createCustomer(buildCustomerInput({ cpfCnpj: input }));

			expect(requestOf().body).toMatchObject({ cpfCnpj: sent });
		});

		it("should forward every optional field in the request body", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(buildCustomer()));
			const input = buildCustomerInput({
				email: "fake.person@example.com",
				mobilePhone: "47999999999",
				externalReference: "user-1",
				notificationDisabled: true,
			});

			await service.createCustomer(input);

			expect(requestOf().body).toEqual({ ...input, cpfCnpj: "52998224725" });
		});

		it("should not mutate the input object", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(buildCustomer()));
			const input = buildCustomerInput();
			const snapshot = { ...input };

			await service.createCustomer(input);

			expect(input).toEqual(snapshot);
		});

		it("should throw when cpfCnpj is undefined at runtime", async () => {
			const { service } = await buildService();
			const input = { name: "Fake Person" } as unknown as CreateAsaasCustomerInput;

			await expect(service.createCustomer(input)).rejects.toThrow(TypeError);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it.each([
			["a network error", new TypeError("fetch failed")],
			["a timeout", new DOMException("The operation timed out", "TimeoutError")],
			["a non-Error rejection", "socket hang up"],
		])("should throw ServiceUnavailableException when fetch fails with %s", async (_l, failure) => {
			const { service } = await buildService();
			fetchMock.mockRejectedValue(failure);

			const act = service.createCustomer(buildCustomerInput());

			await expect(act).rejects.toThrow(ServiceUnavailableException);
			await expect(act).rejects.toThrow("Payment provider unavailable");
			expect(errorLog).toHaveBeenCalledTimes(1);
		});

		it("should throw BadRequestException with the Asaas description when Asaas answers 400", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(
				jsonResponse(asaasError({ code: "invalid_cpfCnpj", description: "Invalid CPF" }), 400),
			);

			const act = service.createCustomer(buildCustomerInput());

			await expect(act).rejects.toThrow(BadRequestException);
			await expect(act).rejects.toThrow("Invalid CPF");
		});

		it("should join every Asaas description when a 400 carries several errors", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(
				jsonResponse(
					asaasError(
						{ code: "invalid_name", description: "Invalid name" },
						{ code: "invalid_cpfCnpj", description: "Invalid CPF" },
					),
					400,
				),
			);

			await expect(service.createCustomer(buildCustomerInput())).rejects.toThrow(
				"Invalid name; Invalid CPF",
			);
		});

		it.each([
			["has an empty errors array", jsonResponse({ errors: [] }, 400)],
			["has no errors field", jsonResponse({}, 400)],
			["has errors that is not an array", jsonResponse({ errors: "boom" }, 400)],
			["is null", jsonResponse(null, 400)],
			["is not JSON", textResponse("<html>Bad Request</html>", 400)],
			["is empty", textResponse("", 400)],
		])("should throw a generic BadRequestException when the 400 body %s", async (_l, response) => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(response);

			const act = service.createCustomer(buildCustomerInput());

			await expect(act).rejects.toThrow(BadRequestException);
			await expect(act).rejects.toThrow("Invalid payment data");
		});

		it.each([401, 403, 404, 409, 429, 500, 502, 503])(
			"should throw BadGatewayException when Asaas answers %i",
			async (status) => {
				const { service } = await buildService();
				fetchMock.mockResolvedValue(
					jsonResponse(asaasError({ code: "some_code", description: "Some description" }), status),
				);

				const act = service.createCustomer(buildCustomerInput());

				await expect(act).rejects.toThrow(BadGatewayException);
				await expect(act).rejects.toThrow("Payment provider error");
			},
		);

		it("should not expose the Asaas description to the caller when Asaas answers 401", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(
				jsonResponse(
					asaasError({ code: "invalid_access_token", description: "The api key is invalid" }),
					401,
				),
			);

			await expect(service.createCustomer(buildCustomerInput())).rejects.not.toThrow(
				"The api key is invalid",
			);
		});

		it("should log the status and error codes when Asaas answers a non-400 error", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(
				jsonResponse(asaasError({ code: "invalid_access_token", description: "x" }), 401),
			);

			await expect(service.createCustomer(buildCustomerInput())).rejects.toThrow();

			expect(loggedText()).toContain("401");
			expect(loggedText()).toContain("invalid_access_token");
		});

		it("should throw BadGatewayException when a 5xx body is not JSON", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(textResponse("<html>Bad Gateway</html>", 502));

			await expect(service.createCustomer(buildCustomerInput())).rejects.toThrow(
				BadGatewayException,
			);
			expect(loggedText()).toContain("no error code");
		});

		it.each([
			["a network failure", () => fetchMock.mockRejectedValue(new TypeError("fetch failed"))],
			["a 401 answer", () => fetchMock.mockResolvedValue(jsonResponse(asaasError(), 401))],
			["a 500 answer", () => fetchMock.mockResolvedValue(jsonResponse(asaasError(), 500))],
		])("should never write the api key to the logs on %s", async (_label, arrange) => {
			const { service } = await buildService();
			arrange();

			await expect(service.createCustomer(buildCustomerInput())).rejects.toThrow();

			expect(loggedText()).not.toContain(API_KEY);
		});

		it("should not retry when Asaas fails", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(asaasError(), 500));

			await expect(service.createCustomer(buildCustomerInput())).rejects.toThrow();

			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("should resolve each concurrent call with its own response", async () => {
			const { service } = await buildService();
			fetchMock
				.mockResolvedValueOnce(jsonResponse(buildCustomer({ id: "cus_a" })))
				.mockResolvedValueOnce(jsonResponse(buildCustomer({ id: "cus_b" })));

			const [first, second] = await Promise.all([
				service.createCustomer(buildCustomerInput({ name: "A" })),
				service.createCustomer(buildCustomerInput({ name: "B" })),
			]);

			expect(first.id).toBe("cus_a");
			expect(second.id).toBe("cus_b");
			expect(requestOf(0).body).toMatchObject({ name: "A" });
			expect(requestOf(1).body).toMatchObject({ name: "B" });
		});

		it("should let one concurrent call succeed when the other one fails", async () => {
			const { service } = await buildService();
			fetchMock
				.mockRejectedValueOnce(new TypeError("fetch failed"))
				.mockResolvedValueOnce(jsonResponse(buildCustomer({ id: "cus_b" })));

			const [first, second] = await Promise.allSettled([
				service.createCustomer(buildCustomerInput()),
				service.createCustomer(buildCustomerInput()),
			]);

			expect(first.status).toBe("rejected");
			expect(second).toEqual({ status: "fulfilled", value: buildCustomer({ id: "cus_b" }) });
		});

		// GAP: a 2xx answer that is not JSON (proxy page, truncated body) escapes
		// as a raw SyntaxError instead of a payment provider error.
		it.each([
			["is not JSON", textResponse("<html>OK</html>", 200)],
			["is empty", textResponse("", 200)],
		])("should throw BadGatewayException when a 200 body %s", async (_label, response) => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(response);

			await expect(service.createCustomer(buildCustomerInput())).rejects.toThrow(
				BadGatewayException,
			);
		});

		// GAP: the response is trusted blindly, so a customer without an id is
		// returned and the caller goes on to store `undefined` as the customer id.
		it.each([
			["null", null],
			["an empty object", {}],
			["a customer with a null id", { ...buildCustomer(), id: null }],
		])("should reject when Asaas answers 200 with %s", async (_label, body) => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(body));

			await expect(service.createCustomer(buildCustomerInput())).rejects.toThrow(
				BadGatewayException,
			);
		});
	});

	describe("createSubscription", () => {
		it("should POST the subscription to Asaas and return the created subscription", async () => {
			const { service } = await buildService();
			const subscription = buildSubscription();
			fetchMock.mockResolvedValue(jsonResponse(subscription));
			const input = buildSubscriptionInput();

			const result = await service.createSubscription(input);

			expect(result).toEqual(subscription);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(requestOf().url).toBe(`${SANDBOX_URL}/subscriptions`);
			expect(requestOf().init.method).toBe("POST");
			expect(requestOf().body).toEqual(input);
		});

		it.each(["CREDIT_CARD", "PIX"] as const)(
			"should send billingType %s unchanged",
			async (billingType) => {
				const { service } = await buildService();
				fetchMock.mockResolvedValue(jsonResponse(buildSubscription({ billingType })));

				await service.createSubscription(buildSubscriptionInput({ billingType }));

				expect(requestOf().body).toMatchObject({ billingType });
			},
		);

		it("should send the api key header", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(buildSubscription()));

			await service.createSubscription(buildSubscriptionInput());

			expect(requestOf().headers.access_token).toBe(API_KEY);
		});

		it("should omit optional fields that are undefined", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(buildSubscription()));

			await service.createSubscription(
				buildSubscriptionInput({ description: undefined, externalReference: undefined }),
			);

			expect(requestOf().body).not.toHaveProperty("description");
			expect(requestOf().body).not.toHaveProperty("externalReference");
		});

		it("should throw BadRequestException with the Asaas description when the customer is invalid", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(
				jsonResponse(
					asaasError({ code: "invalid_customer", description: "Invalid customer" }),
					400,
				),
			);

			const act = service.createSubscription(buildSubscriptionInput({ customer: "cus_missing" }));

			await expect(act).rejects.toThrow(BadRequestException);
			await expect(act).rejects.toThrow("Invalid customer");
		});

		it.each([401, 429, 500])(
			"should throw BadGatewayException when Asaas answers %i",
			async (status) => {
				const { service } = await buildService();
				fetchMock.mockResolvedValue(jsonResponse(asaasError(), status));

				await expect(service.createSubscription(buildSubscriptionInput())).rejects.toThrow(
					BadGatewayException,
				);
			},
		);

		it("should throw ServiceUnavailableException when Asaas does not respond", async () => {
			const { service } = await buildService();
			fetchMock.mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));

			await expect(service.createSubscription(buildSubscriptionInput())).rejects.toThrow(
				ServiceUnavailableException,
			);
		});

		// GAP: a timeout does not mean Asaas did not create the subscription. The
		// service gives the caller no way to tell, so a subscription can be left
		// on Asaas with no local record. This documents the single attempt only.
		it("should not retry a subscription that timed out", async () => {
			const { service } = await buildService();
			fetchMock.mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));

			await expect(service.createSubscription(buildSubscriptionInput())).rejects.toThrow();

			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		// GAP: same blind trust as createCustomer.
		it.each([
			["null", null],
			["an empty object", {}],
		])("should reject when Asaas answers 200 with %s", async (_label, body) => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(body));

			await expect(service.createSubscription(buildSubscriptionInput())).rejects.toThrow(
				BadGatewayException,
			);
		});
	});

	describe("listSubscriptionPayments", () => {
		it("should GET the payments of the subscription and return the data array", async () => {
			const { service } = await buildService();
			const payments = [buildPayment({ id: "pay_1" }), buildPayment({ id: "pay_2" })];
			fetchMock.mockResolvedValue(jsonResponse({ object: "list", hasMore: false, data: payments }));

			const result = await service.listSubscriptionPayments("sub_fake_1");

			expect(result).toEqual(payments);
			expect(requestOf().url).toBe(`${SANDBOX_URL}/subscriptions/sub_fake_1/payments`);
			expect(requestOf().init.method).toBe("GET");
		});

		it("should not send a body with the GET request", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

			await service.listSubscriptionPayments("sub_fake_1");

			expect(requestOf().init).not.toHaveProperty("body");
		});

		it("should url-encode the subscription id", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

			await service.listSubscriptionPayments("sub/../customers?x=1");

			expect(requestOf().url).toBe(
				`${SANDBOX_URL}/subscriptions/sub%2F..%2Fcustomers%3Fx%3D1/payments`,
			);
		});

		it.each([
			["data is an empty array", { data: [] }],
			["data is missing", { object: "list" }],
			["data is null", { data: null }],
		])("should return an empty array when %s", async (_label, body) => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(body));

			await expect(service.listSubscriptionPayments("sub_fake_1")).resolves.toEqual([]);
		});

		it("should throw BadGatewayException when Asaas answers 404", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(asaasError(), 404));

			await expect(service.listSubscriptionPayments("sub_missing")).rejects.toThrow(
				BadGatewayException,
			);
		});

		it("should throw ServiceUnavailableException when Asaas does not respond", async () => {
			const { service } = await buildService();
			fetchMock.mockRejectedValue(new TypeError("fetch failed"));

			await expect(service.listSubscriptionPayments("sub_fake_1")).rejects.toThrow(
				ServiceUnavailableException,
			);
		});

		// GAP: a null body makes the service read `.data` of null.
		it("should return an empty array when Asaas answers 200 with null", async () => {
			const { service } = await buildService();
			fetchMock.mockResolvedValue(jsonResponse(null));

			await expect(service.listSubscriptionPayments("sub_fake_1")).resolves.toEqual([]);
		});
	});

	describe("isValidWebhookToken", () => {
		it("should return true when the token matches the configured one", async () => {
			const { service } = await buildService();

			expect(service.isValidWebhookToken(WEBHOOK_TOKEN)).toBe(true);
		});

		it.each([
			["a different token of the same length", WEBHOOK_TOKEN.replace(/.$/, "X")],
			["a prefix of the token", WEBHOOK_TOKEN.slice(0, -1)],
			["the token with a trailing character", `${WEBHOOK_TOKEN}x`],
			["the token in another case", WEBHOOK_TOKEN.toUpperCase()],
			["the token with surrounding spaces", ` ${WEBHOOK_TOKEN} `],
			["the api key", API_KEY],
			["an empty string", ""],
			["undefined", undefined],
		])("should return false when given %s", async (_label, token) => {
			const { service } = await buildService();

			expect(service.isValidWebhookToken(token)).toBe(false);
		});

		it("should return false when a multi-byte token has the same character count", async () => {
			const { service } = await buildService({ ASAAS_WEBHOOK_TOKEN: "abcd" });

			expect(service.isValidWebhookToken("abcé")).toBe(false);
		});

		it("should return true when a multi-byte token matches", async () => {
			const token = "tóken-with-accents-0123456789-ç";
			const { service } = await buildService({ ASAAS_WEBHOOK_TOKEN: token });

			expect(service.isValidWebhookToken(token)).toBe(true);
		});

		it.each([
			["is not set", undefined],
			["is an empty string", ""],
		])("should reject every token when ASAAS_WEBHOOK_TOKEN %s", async (_label, configured) => {
			const { service } = await buildService({ ASAAS_WEBHOOK_TOKEN: configured });

			expect(service.isValidWebhookToken(WEBHOOK_TOKEN)).toBe(false);
			expect(service.isValidWebhookToken("")).toBe(false);
			expect(service.isValidWebhookToken(undefined)).toBe(false);
		});

		it("should warn when a webhook arrives and no token is configured", async () => {
			const { service } = await buildService({ ASAAS_WEBHOOK_TOKEN: undefined });

			service.isValidWebhookToken(WEBHOOK_TOKEN);

			expect(warnLog).toHaveBeenCalledTimes(1);
		});

		it("should not call Asaas to validate a token", async () => {
			const { service } = await buildService();

			service.isValidWebhookToken(WEBHOOK_TOKEN);

			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
