import {
	BadRequestException,
	ConflictException,
	Injectable,
	UnauthorizedException,
} from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, count, eq } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { planTable } from "../db/schemas/plans.js";
import { promoCodeRedemptions } from "../db/schemas/promo-code-redemptions.js";
import { promoCodesTable } from "../db/schemas/promo-codes.js";
import { subscriptionTable } from "../db/schemas/subscriptions.js";
import { User, userTable } from "../db/schemas/user.js";
import { SubscribeDTO } from "./dto/create-subscription.dto.js";

@Injectable()
export class SubscriptionService {
	constructor(@InjectDrizzle() private readonly db: NodePgDatabase) {}

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

		//add to queue here and create the payment onto the asaas
		return newSubscription;
	}

	async listPlans() {
		const plans = await this.db.select().from(planTable).where(eq(planTable.is_active, true));
		return plans;
	}
}
