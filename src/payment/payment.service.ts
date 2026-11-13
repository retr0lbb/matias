import { timingSafeEqual } from "node:crypto";
import {
	BadGatewayException,
	BadRequestException,
	Injectable,
	Logger,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
	AsaasCustomer,
	AsaasErrorResponse,
	CreateAsaasCustomerInput,
} from "./dto/asaas-customer.dto.js";
import type {
	AsaasPayment,
	AsaasSubscription,
	CreateAsaasSubscriptionInput,
} from "./dto/asaas-subscription.dto.js";

const ASAAS_SANDBOX_URL = "https://api-sandbox.asaas.com/v3";
// Asaas requires a User-Agent identifying the application.
const USER_AGENT = "MATIAS/1.0.0";
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class PaymentService {
	private readonly logger = new Logger(PaymentService.name);
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly webhookToken: string | undefined;

	constructor(configService: ConfigService) {
		this.webhookToken = configService.get<string>("ASAAS_WEBHOOK_TOKEN") || undefined;
		this.apiKey = configService.getOrThrow<string>("ASAAS_API_KEY");
		this.baseUrl = (configService.get<string>("ASAAS_API_URL") || ASAAS_SANDBOX_URL).replace(
			/\/+$/,
			"",
		);
	}

	/**
	 * Creates a customer on Asaas and returns it. Asaas does not dedupe
	 * customers: callers must store the returned `id` and reuse it.
	 */
	async createCustomer(input: CreateAsaasCustomerInput): Promise<AsaasCustomer> {
		return this.post<AsaasCustomer>("/customers", {
			...input,
			cpfCnpj: input.cpfCnpj.replace(/\D/g, ""),
		});
	}

	/**
	 * Creates a recurring subscription on Asaas. This does not confirm any
	 * payment: Asaas generates one charge per cycle.
	 */
	async createSubscription(input: CreateAsaasSubscriptionInput): Promise<AsaasSubscription> {
		return this.post<AsaasSubscription>("/subscriptions", input);
	}

	/**
	 * Lists the charges Asaas already generated for a subscription. The first
	 * one exists right after the subscription is created.
	 */
	async listSubscriptionPayments(subscriptionId: string): Promise<AsaasPayment[]> {
		const list = await this.request<{ data?: AsaasPayment[] }>(
			"GET",
			`/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
		);
		return list.data ?? [];
	}

	/**
	 * Checks the `asaas-access-token` header of an incoming webhook against
	 * `ASAAS_WEBHOOK_TOKEN`. Fails closed when the token is not configured.
	 */
	isValidWebhookToken(token: string | undefined): boolean {
		if (!this.webhookToken) {
			this.logger.warn("ASAAS_WEBHOOK_TOKEN is not set; rejecting Asaas webhook");
			return false;
		}
		if (!token) return false;

		if (token !== this.webhookToken) {
			return false;
		}

		return true;
	}

	private post<T>(path: string, body: object): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	private async request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
		let response: Response;

		try {
			const init: RequestInit = {
				method,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"User-Agent": USER_AGENT,
					access_token: this.apiKey,
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			};
			// Asaas answers 403 to a GET that carries a body.
			if (body !== undefined) init.body = JSON.stringify(body);

			response = await fetch(`${this.baseUrl}${path}`, init);
		} catch (error) {
			this.logger.error(
				`Asaas ${method} ${path} did not respond: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw new ServiceUnavailableException("Payment provider unavailable");
		}

		if (!response.ok) {
			const errors = await readErrors(response);

			if (response.status === 400) {
				throw new BadRequestException(
					errors.map((error) => error.description).join("; ") || "Invalid payment data",
				);
			}

			this.logger.error(
				`Asaas ${method} ${path} failed with ${response.status}: ${errors.map((error) => error.code).join(", ") || "no error code"}`,
			);
			throw new BadGatewayException("Payment provider error");
		}

		return (await response.json()) as T;
	}
}

async function readErrors(response: Response): Promise<AsaasErrorResponse["errors"]> {
	try {
		const payload = (await response.json()) as Partial<AsaasErrorResponse>;
		return Array.isArray(payload.errors) ? payload.errors : [];
	} catch {
		return [];
	}
}
