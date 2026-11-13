import z from "zod/v4";

export const subscribeSchema = z.object({
	planId: z.uuid(),
	discountCode: z.string().optional(),
});

export type SubscribeDTO = z.infer<typeof subscribeSchema>;
