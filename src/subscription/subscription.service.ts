import {
	BadRequestException,
	ConflictException,
	Injectable,
	InternalServerErrorException,
	UnauthorizedException,
} from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { planTable } from "../db/schemas/plans.js";
import { promoCodeRedemptions } from "../db/schemas/promo-code-redemptions.js";
import { promoCodesTable } from "../db/schemas/promo-codes.js";
import { subscriptionTable } from "../db/schemas/subscriptions.js";
import { planEnum, User, userTable } from "../db/schemas/user.js";
import type { AsaasCycle } from "../payment/dto/asaas-subscription.dto.js";
import { PaymentService } from "../payment/payment.service.js";
import { SubscribeDTO } from "./dto/create-subscription.dto.js";

// plans.billing_interval -> Asaas cycle. "MONTLY" is how the current Pro plan
// row is spelled in the database.
const ASAAS_CYCLE_BY_INTERVAL: Record<string, AsaasCycle | undefined> = {
	WEEKLY: "WEEKLY",
	MONTHLY: "MONTHLY",
	MONTLY: "MONTHLY",
	QUARTERLY: "QUARTERLY",
	SEMIANNUALLY: "SEMIANNUALLY",
	YEARLY: "YEARLY",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SubscriptionService {
	constructor(
		@InjectDrizzle() private readonly db: NodePgDatabase,
		private readonly paymentService: PaymentService,
	) {}

	async createSubscription(user: User, payload: SubscribeDTO) {
		const [foundUser] = await this.db.select().from(userTable).where(eq(userTable.id, user.id));
		if (!foundUser) throw new UnauthorizedException("User not logged in");

		const [hasDiscount] = payload.discountCode
			? await this.db
					.select()
					.from(promoCodesTable)
					.where(eq(promoCodesTable.code, payload.discountCode))
			: [null];

		console.log(hasDiscount);

		if (!hasDiscount && payload.discountCode) {
			throw new BadRequestException("Invalid promotional code");
		}

		if (hasDiscount) {
			if (!hasDiscount.isValid) {
				throw new BadRequestException("Discount code is invalid");
			}

			if (new Date(hasDiscount.endsAt) < new Date()) {
				throw new BadRequestException("Discount code is expired");
			}

			if (hasDiscount.maxRedemptionsGlobal !== null) {
				const [countRedeem] = await this.db
					.select({ count: count() })
					.from(promoCodeRedemptions)
					.where(
						and(
							eq(promoCodeRedemptions.promoCodeId, hasDiscount.id),
							eq(promoCodeRedemptions.status, "APPLIED"),
						),
					);

				if (countRedeem.count >= hasDiscount.maxRedemptionsGlobal)
					throw new BadRequestException("Maximum global request for this code");
			}

			if (hasDiscount.maxRedemptionsUser) {
				const [userRedemptions] = await this.db
					.select({
						count: count(),
					})
					.from(promoCodeRedemptions)
					.where(
						and(
							eq(promoCodeRedemptions.promoCodeId, hasDiscount.id),
							eq(promoCodeRedemptions.userId, user.id),
						),
					);
				if (userRedemptions.count >= hasDiscount.maxRedemptionsUser) {
					throw new BadRequestException("Code is already taken");
				}
			}
		}

		const [plann] = await this.db.select().from(planTable).where(eq(planTable.id, payload.planId));

		if (!plann || plann.is_active === false) {
			throw new BadRequestException("Cannot subscribe to this plan");
		}

		const cycle = ASAAS_CYCLE_BY_INTERVAL[plann.billing_interval.toUpperCase()];
		if (!cycle) {
			throw new InternalServerErrorException("Plan has an unsupported billing interval");
		}

		const [hasAlreadyASubscription] = await this.db
			.select()
			.from(subscriptionTable)
			.where(
				and(eq(subscriptionTable.plan_id, payload.planId), eq(subscriptionTable.user_id, user.id)),
			); //ver se eh justo fazer isso

		if (hasAlreadyASubscription) {
			throw new ConflictException("Subscription already exists"); //tratar melhor esse erro
		}

		const [newSubscription] = await this.db
			.insert(subscriptionTable)
			.values({
				plan_id: payload.planId,
				user_id: user.id,
				status: "PENDING",
			})
			.returning();

		if (hasDiscount) {
			await this.db.insert(promoCodeRedemptions).values({
				discountValue: hasDiscount.discountValue,
				durationInCicle: hasDiscount.durationInCicle,
				promoCodeId: hasDiscount.id,
				userId: user.id,
				discountType: hasDiscount.discountType,
				subscriptionId: newSubscription.id,
				status: "PENDING",
			});
		}

		try {
			const customerId = await this.resolveCustomerId(foundUser, payload);

			await this.db
				.update(subscriptionTable)
				.set({ customerId })
				.where(eq(subscriptionTable.id, newSubscription.id));

			const asaasSubscription = await this.paymentService.createSubscription({
				customer: customerId,
				billingType: payload.paymentMethod,
				value: plann.price / 100, // plan price is stored in cents
				nextDueDate: new Date().toISOString().slice(0, 10),
				cycle,
				description: plann.name,
				externalReference: newSubscription.id,
			});

			await this.db
				.update(subscriptionTable)
				.set({ asaasSubscriptionId: asaasSubscription.id })
				.where(eq(subscriptionTable.id, newSubscription.id));

			// The subscription already exists on Asaas at this point, so failing to
			// read the invoice link must not undo the local intent.
			const [firstPayment] = await this.paymentService
				.listSubscriptionPayments(asaasSubscription.id)
				.catch(() => []);

			return {
				...newSubscription,
				customerId,
				asaasSubscriptionId: asaasSubscription.id,
				paymentMethod: payload.paymentMethod,
				paymentUrl: firstPayment?.invoiceUrl ?? null,
			};
		} catch (error) {
			// Nothing was charged: drop the intent so the user can try again.
			await this.db
				.delete(promoCodeRedemptions)
				.where(eq(promoCodeRedemptions.subscriptionId, newSubscription.id));
			await this.db.delete(subscriptionTable).where(eq(subscriptionTable.id, newSubscription.id));
			throw error;
		}
	}

	/** Asaas does not dedupe customers, so reuse the id from a previous subscription. */
	private async resolveCustomerId(user: User, payload: SubscribeDTO): Promise<string> {
		const [previous] = await this.db
			.select({ customerId: subscriptionTable.customerId })
			.from(subscriptionTable)
			.where(and(eq(subscriptionTable.user_id, user.id), isNotNull(subscriptionTable.customerId)))
			.limit(1);

		if (previous?.customerId) return previous.customerId;

		const customer = await this.paymentService.createCustomer({
			name: payload.fullName,
			cpfCnpj: payload.cpf,
			email: user.email,
			externalReference: user.id,
		});

		return customer.id;
	}

	/**
	 * Activates the PENDING subscription a paid Asaas charge belongs to and
	 * moves the user to the plan. `externalReference` is the local subscription
	 * id we sent to Asaas. Returns false when there is nothing to activate
	 * (unknown reference, or already activated by an earlier delivery).
	 */
	async activateFromPayment(externalReference: string | null | undefined): Promise<boolean> {
		if (!externalReference || !UUID_PATTERN.test(externalReference)) return false;

		return this.db.transaction(async (tx) => {
			const [activated] = await tx
				.update(subscriptionTable)
				.set({ status: "ACTIVE" })
				.where(
					and(
						eq(subscriptionTable.id, externalReference),
						eq(subscriptionTable.status, "PENDING"),
					),
				)
				.returning();

			if (!activated) return false;

			const [plan] = await tx.select().from(planTable).where(eq(planTable.id, activated.plan_id));
			const userPlan = planEnum.enumValues.find((value) => value === plan?.name.toUpperCase());

			if (userPlan) {
				await tx
					.update(userTable)
					.set({ plan: userPlan, cycleAnchorAt: new Date() })
					.where(eq(userTable.id, activated.user_id));
			}

			return true;
		});
	}

	async listPlans() {
		const plans = await this.db.select().from(planTable).where(eq(planTable.is_active, true));
		return plans;
	}
}
