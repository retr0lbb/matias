import {
	BadRequestException,
	ConflictException,
	Injectable,
	InternalServerErrorException,
	UnauthorizedException,
} from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, eq, inArray, isNotNull, not } from "drizzle-orm";
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
				and(
					eq(subscriptionTable.plan_id, payload.planId),
					eq(subscriptionTable.user_id, user.id),
					not(eq(subscriptionTable.status, "INACTIVE")),
				),
			);

		if (hasAlreadyASubscription) {
			throw new ConflictException("Subscription already exists"); //tratar melhor esse erro
		}

		const discountCode = payload.discountCode?.trim().toUpperCase() || undefined;
		const { newSubscription, coupon } = await this.db
			.transaction(async (tx) => {
				const [newSubscription] = await tx
					.insert(subscriptionTable)
					.values({
						plan_id: payload.planId,
						user_id: user.id,
						status: "PENDING",
					})
					.returning();

				if (!discountCode) return { newSubscription, coupon: null };

				const [coupon] = await tx
					.select()
					.from(promoCodesTable)
					.where(eq(promoCodesTable.code, discountCode))
					.for("update");

				if (!coupon) {
					throw new BadRequestException("Invalid promotional code");
				}

				if (!coupon.isValid) {
					throw new BadRequestException("Discount code is invalid");
				}

				if (new Date(coupon.endsAt) < new Date()) {
					throw new BadRequestException("Discount code is expired");
				}

				if (coupon.maxRedemptionsGlobal !== null) {
					const [redeemed] = await tx
						.select({ count: count() })
						.from(promoCodeRedemptions)
						.where(
							and(
								eq(promoCodeRedemptions.promoCodeId, coupon.id),
								inArray(promoCodeRedemptions.status, ["PENDING", "APPLIED"]),
							),
						);

					if (redeemed.count >= coupon.maxRedemptionsGlobal) {
						throw new BadRequestException("Maximum global request for this code");
					}
				}

				if (coupon.maxRedemptionsUser !== null) {
					const [userRedemptions] = await tx
						.select({ count: count() })
						.from(promoCodeRedemptions)
						.where(
							and(
								eq(promoCodeRedemptions.promoCodeId, coupon.id),
								eq(promoCodeRedemptions.userId, user.id),
								inArray(promoCodeRedemptions.status, ["PENDING", "APPLIED"]),
							),
						);

					if (userRedemptions.count >= coupon.maxRedemptionsUser) {
						throw new BadRequestException("This account already registered a coupon");
					}
				}

				await tx.insert(promoCodeRedemptions).values({
					discountValue: coupon.discountValue,
					durationInCicle: coupon.durationInCicle,
					promoCodeId: coupon.id,
					userId: user.id,
					subscriptionId: newSubscription.id,
					discountType: coupon.discountType,
					status: "PENDING",
				});

				return { newSubscription, coupon };
			})
			.catch((error) => {
				if (isUniqueViolation(error)) {
					throw new ConflictException("User already has a subscription in progress or active");
				}
				throw error;
			});

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
					and(eq(subscriptionTable.id, externalReference), eq(subscriptionTable.status, "PENDING")),
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

function isUniqueViolation(error: unknown): boolean {
	const err = error as { code?: string; cause?: { code?: string } };
	// dependendo da versão do Drizzle, o erro do pg vem em `cause`
	return err?.code === "23505" || err?.cause?.code === "23505";
}
