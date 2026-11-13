import z from "zod/v4";

// Only the fields we read. Asaas adds fields over time, so unknown keys are
// dropped instead of rejected.
export const asaasWebhookSchema = z.object({
	id: z.string().optional(),
	event: z.string(),
	// PAYMENT_* events. `subscription` is the Asaas subscription id (sub_...).
	payment: z
		.object({
			id: z.string().optional(),
			subscription: z.string().nullish(),
			externalReference: z.string().nullish(),
		})
		.optional(),
	// SUBSCRIPTION_* events.
	subscription: z
		.object({
			id: z.string().optional(),
			externalReference: z.string().nullish(),
		})
		.optional(),
});

export type AsaasWebhookEvent = z.infer<typeof asaasWebhookSchema>;
