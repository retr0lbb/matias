import { eq } from "drizzle-orm";
import { subscriptionTable } from "../db/schemas/subscriptions.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Condition that finds the local subscription an Asaas object belongs to: our
 * id when `externalReference` is one of ours, otherwise the Asaas subscription
 * id. Returns undefined when neither can identify a subscription.
 */
export function matchSubscription(
	externalReference: string | null | undefined,
	asaasSubscriptionId: string | null | undefined,
) {
	if (externalReference && UUID_PATTERN.test(externalReference)) {
		return eq(subscriptionTable.id, externalReference);
	}
	if (asaasSubscriptionId) {
		return eq(subscriptionTable.asaasSubscriptionId, asaasSubscriptionId);
	}
	return undefined;
}
