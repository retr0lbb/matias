import type { BillingType, PaymentStatus, paymentTables } from "../db/schemas/payments.js";

/** The fields of an Asaas charge we store; all optional because webhooks vary. */
export interface AsaasCharge {
	id?: string | null;
	customer?: string | null;
	billingType?: string | null;
	/** Amount in BRL (e.g. 29.9). */
	value?: number | null;
	/** `YYYY-MM-DD`. */
	dueDate?: string | null;
}

const BILLING_TYPE_BY_ASAAS: Record<string, BillingType | undefined> = {
	PIX: "PIX",
	BOLETO: "BOLETO",
	CREDIT_CARD: "CARTAO_DE_CREDITO",
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Maps an Asaas charge to a `payments` row. Returns null when the charge lacks
 * something the table requires (id, customer, a known billing type, a value).
 */
export function toPaymentRow(
	charge: AsaasCharge,
	owner: { userId: string; subscriptionId: string },
	status: PaymentStatus,
): typeof paymentTables.$inferInsert | null {
	const billingType = charge.billingType ? BILLING_TYPE_BY_ASAAS[charge.billingType] : undefined;

	if (!charge.id || !charge.customer || !billingType) return null;
	if (typeof charge.value !== "number" || !Number.isFinite(charge.value)) return null;

	return {
		userId: owner.userId,
		subscriptionId: owner.subscriptionId,
		asaasPaymentId: charge.id,
		customerId: charge.customer,
		billingType,
		dueDate: charge.dueDate && DATE_PATTERN.test(charge.dueDate) ? charge.dueDate : null,
		status,
		value: Math.round(charge.value * 100), // BRL -> cents
		paidAt: status === "PAID" ? new Date() : null,
	};
}
