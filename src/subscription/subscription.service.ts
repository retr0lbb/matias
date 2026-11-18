import {
	BadRequestException,
	ConflictException,
	Injectable,
	InternalServerErrorException,
	UnauthorizedException,
} from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, eq, inArray, isNotNull, isNull, not } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { paymentTables } from "../db/schemas/payments.js";
import { planTable } from "../db/schemas/plans.js";
import { promoCodeRedemptions } from "../db/schemas/promo-code-redemptions.js";
import { promoCodesTable } from "../db/schemas/promo-codes.js";
import { subscriptionTable } from "../db/schemas/subscriptions.js";
import { planEnum, User, userTable } from "../db/schemas/user.js";
import type { AsaasCycle } from "../payment/dto/asaas-subscription.dto.js";
import { PaymentService } from "../payment/payment.service.js";
import { SubscribeDTO } from "./dto/create-subscription.dto.js";
import { type AsaasCharge, toPaymentRow } from "./payment-record.js";
import { discountedPrice, MIN_CHARGE_CENTS, toAsaasDiscount } from "./promo-discount.js";
import { matchSubscription } from "./subscription-match.js";

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
		const { newSubscription, promo } = await this.db
			.transaction(async (tx) => {
				const [newSubscription] = await tx
					.insert(subscriptionTable)
					.values({
						plan_id: payload.planId,
						user_id: user.id,
						status: "PENDING",
					})
					.returning();

				if (!discountCode) return { newSubscription, promo: null };

				const [coupon] = await tx
					.select()
					.from(promoCodesTable)
					.where(eq(promoCodesTable.code, discountCode))
					.for("update");

				if (!coupon) {
					throw new BadRequestException("Invalid promotional code");
				}

				if (!coupon.isValid || !coupon.discountType || coupon.discountValue <= 0) {
					throw new BadRequestException("Discount code is invalid");
				}

				if (new Date(coupon.startsAt) > new Date()) {
					throw new BadRequestException("Discount code is not active yet");
				}

				if (new Date(coupon.endsAt) < new Date()) {
					throw new BadRequestException("Discount code is expired");
				}

				// Throwing here rolls the pending subscription back.
				const priceWithDiscount = discountedPrice(
					plann.price,
					coupon.discountType,
					coupon.discountValue,
				);
				if (priceWithDiscount < MIN_CHARGE_CENTS) {
					throw new BadRequestException("Discount code cannot be applied to this plan");
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

				return {
					newSubscription,
					promo: {
						discount: toAsaasDiscount(coupon.discountType, coupon.discountValue),
						discountedPrice: priceWithDiscount,
						cycles: coupon.durationInCicle,
					},
				};
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
				// The value stays the full price: Asaas applies the discount to each
				// charge until endDiscountIfExhausted removes it.
				...(promo ? { discount: promo.discount } : {}),
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

			if (firstPayment) {
				await this.storeFirstCharge(firstPayment, user.id, newSubscription.id);
			}

			return {
				...newSubscription,
				customerId,
				asaasSubscriptionId: asaasSubscription.id,
				paymentMethod: payload.paymentMethod,
				paymentUrl: firstPayment?.invoiceUrl ?? null,
				// Prices in cents. The discounted one holds for `discountedCycles`
				// charges, each only when paid by its due date.
				originalPrice: plann.price,
				discountedPrice: promo?.discountedPrice ?? null,
				discountedCycles: promo?.cycles ?? null,
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

	/**
	 * Stores the first charge of a subscription as PENDING. Never throws: the
	 * subscription already exists on Asaas, and the PAYMENT_CREATED webhook
	 * stores the same charge (it may even have done so already).
	 */
	private async storeFirstCharge(charge: AsaasCharge, userId: string, subscriptionId: string) {
		const row = toPaymentRow(charge, { userId, subscriptionId }, "PENDING");
		if (!row) return;

		try {
			await this.db.insert(paymentTables).values(row);
		} catch {
			// Already stored by the webhook, or the database failed; the webhook
			// events of this charge will store it either way.
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
	 * id we sent to Asaas; when it is missing or not ours, the Asaas subscription
	 * id is used instead. Returns false when there is nothing to activate
	 * (unknown reference, or already activated by an earlier delivery).
	 */
	async activateFromPayment(
		externalReference: string | null | undefined,
		asaasSubscriptionId?: string | null,
	): Promise<boolean> {
		const match = matchSubscription(externalReference, asaasSubscriptionId);
		if (!match) return false;

		return this.db.transaction(async (tx) => {
			const [activated] = await tx
				.update(subscriptionTable)
				.set({ status: "ACTIVE" })
				.where(and(match, eq(subscriptionTable.status, "PENDING")))
				.returning();

			if (!activated) return false;

			// The first payment is what turns a reserved promo code into a used one.
			await tx
				.update(promoCodeRedemptions)
				.set({ status: "APPLIED", redeemedAt: new Date() })
				.where(
					and(
						eq(promoCodeRedemptions.subscriptionId, activated.id),
						eq(promoCodeRedemptions.status, "PENDING"),
					),
				);

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

	/**
	 * Moves a past due (`EXPIRED`) subscription back to ACTIVE when its overdue
	 * charge is finally paid. The user never left the plan, so only the
	 * subscription changes. Returns false when there is nothing past due.
	 */
	async reactivatePastDue(
		externalReference: string | null | undefined,
		asaasSubscriptionId?: string | null,
	): Promise<boolean> {
		const match = matchSubscription(externalReference, asaasSubscriptionId);
		if (!match) return false;

		const [reactivated] = await this.db
			.update(subscriptionTable)
			.set({ status: "ACTIVE" })
			.where(and(match, eq(subscriptionTable.status, "EXPIRED")))
			.returning({ id: subscriptionTable.id });

		return Boolean(reactivated);
	}

	/**
	 * Marks an ACTIVE subscription as past due (`EXPIRED`) when a charge is
	 * overdue. The subscription is still live and the user keeps the plan.
	 * Returns false when there is no active subscription to mark.
	 */
	async markPastDue(
		externalReference: string | null | undefined,
		asaasSubscriptionId?: string | null,
	): Promise<boolean> {
		const match = matchSubscription(externalReference, asaasSubscriptionId);
		if (!match) return false;

		const [pastDue] = await this.db
			.update(subscriptionTable)
			.set({ status: "EXPIRED" })
			.where(and(match, eq(subscriptionTable.status, "ACTIVE")))
			.returning({ id: subscriptionTable.id });

		return Boolean(pastDue);
	}

	/**
	 * Ends a live subscription (refund, chargeback, cancellation on Asaas) and
	 * moves the user back to the free plan. Returns false when there is no live
	 * subscription to end.
	 */
	async deactivate(
		externalReference: string | null | undefined,
		asaasSubscriptionId: string | null | undefined,
		reason: string,
	): Promise<boolean> {
		const match = matchSubscription(externalReference, asaasSubscriptionId);
		if (!match) return false;

		return this.db.transaction(async (tx) => {
			const [ended] = await tx
				.update(subscriptionTable)
				.set({ status: "INACTIVE", cancelledAt: new Date(), cancelReason: reason })
				.where(and(match, inArray(subscriptionTable.status, ["PENDING", "ACTIVE", "EXPIRED"])))
				.returning();

			if (!ended) return false;

			await tx.update(userTable).set({ plan: "FREE" }).where(eq(userTable.id, ended.user_id));

			// A revoked redemption no longer counts toward the limits of the code.
			await tx
				.update(promoCodeRedemptions)
				.set({ status: "REVOKED" })
				.where(
					and(
						eq(promoCodeRedemptions.subscriptionId, ended.id),
						inArray(promoCodeRedemptions.status, ["PENDING", "APPLIED"]),
					),
				);

			return true;
		});
	}

	/**
	 * Removes the promo discount from the Asaas subscription once every
	 * discounted cycle was paid, so the next charges are the full price. Meant to
	 * run after a paid charge was stored in `payments`. Returns false when there
	 * is nothing to remove: no applied promo code, discount already removed, or
	 * discounted cycles still left. An Asaas failure is thrown and nothing is
	 * marked, so the next delivery of the event tries again.
	 */
	async endDiscountIfExhausted(
		externalReference: string | null | undefined,
		asaasSubscriptionId?: string | null,
	): Promise<boolean> {
		const match = matchSubscription(externalReference, asaasSubscriptionId);
		if (!match) return false;

		const [subscription] = await this.db
			.select({
				id: subscriptionTable.id,
				asaasSubscriptionId: subscriptionTable.asaasSubscriptionId,
			})
			.from(subscriptionTable)
			.where(match)
			.limit(1);
		if (!subscription?.asaasSubscriptionId) return false;

		const [redemption] = await this.db
			.select()
			.from(promoCodeRedemptions)
			.where(
				and(
					eq(promoCodeRedemptions.subscriptionId, subscription.id),
					eq(promoCodeRedemptions.status, "APPLIED"),
					isNull(promoCodeRedemptions.discountRemovedAt),
				),
			)
			.limit(1);
		if (!redemption?.discountType) return false;

		// One row per charge, so a card's CONFIRMED + RECEIVED pair counts once.
		const [paid] = await this.db
			.select({ count: count() })
			.from(paymentTables)
			.where(
				and(eq(paymentTables.subscriptionId, subscription.id), eq(paymentTables.status, "PAID")),
			);
		if ((paid?.count ?? 0) < redemption.durationInCicle) return false;

		await this.paymentService.updateSubscription(subscription.asaasSubscriptionId, {
			discount: { value: 0, dueDateLimitDays: 0, type: redemption.discountType },
			updatePendingPayments: true,
		});

		await this.db
			.update(promoCodeRedemptions)
			.set({ discountRemovedAt: new Date() })
			.where(eq(promoCodeRedemptions.id, redemption.id));

		return true;
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
