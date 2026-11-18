import type { discountTypeEnum } from "../db/schemas/promo-codes.js";
import type { AsaasDiscount } from "../payment/dto/asaas-subscription.dto.js";

export type DiscountType = (typeof discountTypeEnum.enumValues)[number];

/** Asaas refuses charges below R$ 5,00. */
export const MIN_CHARGE_CENTS = 500;

/**
 * Price in cents after a promo code. `PERCENTAGE` values are whole percents
 * (10 = 10%) and the result is rounded down to the cent; `FIXED` values are in
 * cents, like `plans.price`.
 */
export function discountedPrice(priceCents: number, type: DiscountType, value: number): number {
	if (type === "PERCENTAGE") return Math.floor((priceCents * (100 - value)) / 100);
	return priceCents - value;
}

/**
 * The promo code as the Asaas `discount` object. Asaas takes fixed discounts
 * in BRL, and only grants the discount to charges paid by their due date
 * (`dueDateLimitDays: 0`).
 */
export function toAsaasDiscount(type: DiscountType, value: number): AsaasDiscount {
	return {
		type,
		value: type === "FIXED" ? value / 100 : value,
		dueDateLimitDays: 0,
	};
}
