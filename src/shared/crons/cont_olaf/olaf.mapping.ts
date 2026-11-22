/**
 * The webhook event each Asaas charge status stands for, so a charge read
 * from the API goes through the same `payments` rules as a webhook. Statuses
 * missing here (awaiting risk analysis, dunning, ...) are left alone.
 */
export const EVENT_BY_CHARGE_STATUS: Readonly<Record<string, string | undefined>> = {
	PENDING: "PAYMENT_CREATED",
	CONFIRMED: "PAYMENT_CONFIRMED",
	RECEIVED: "PAYMENT_RECEIVED",
	RECEIVED_IN_CASH: "PAYMENT_RECEIVED",
	OVERDUE: "PAYMENT_OVERDUE",
	REFUNDED: "PAYMENT_REFUNDED",
	CHARGEBACK_REQUESTED: "PAYMENT_CHARGEBACK_REQUESTED",
};

/** Charge statuses that mean the money arrived. */
export const PAID_CHARGE_STATUSES: ReadonlySet<string> = new Set([
	"CONFIRMED",
	"RECEIVED",
	"RECEIVED_IN_CASH",
]);

/** Returns the webhook event for an Asaas charge status, or undefined. */
export function eventForChargeStatus(status: string | null | undefined): string | undefined {
	if (!status || !Object.hasOwn(EVENT_BY_CHARGE_STATUS, status)) return undefined;
	return EVENT_BY_CHARGE_STATUS[status];
}
