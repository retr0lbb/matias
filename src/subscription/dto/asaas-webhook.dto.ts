import z from "zod/v4";

// Only the fields we read. Asaas adds fields over time, so unknown keys are
// dropped instead of rejected.
export const asaasWebhookSchema = z.object({
	id: z.string().optional(),
	event: z.string(),
	payment: z
		.object({
			id: z.string(),
			subscription: z.string().nullish(),
			externalReference: z.string().nullish(),
		})
		.optional(),
});

export type AsaasWebhookEvent = z.infer<typeof asaasWebhookSchema>;
