import z from "zod/v4";

export const subscribeSchema = z.object({
	planId: z.uuid(),
	discountCode: z.string().optional(),
	// PIX is charged again every cycle; CREDIT_CARD is charged automatically
	// after the first payment on the Asaas invoice.
	paymentMethod: z.enum(["CREDIT_CARD", "PIX"]),
	// Temporary: collected on the request until they are stored on the user.
	fullName: z.string().trim().min(3),
	cpf: z.string().regex(/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/),
});

export type SubscribeDTO = z.infer<typeof subscribeSchema>;
