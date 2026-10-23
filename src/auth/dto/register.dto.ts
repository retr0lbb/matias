import {z} from "zod/v4"

const registerSchema = z.object({
    email: z.email(),
    password: z.string().min(8).max(32)
})

//Later add zod validation pipe global pipes, piperpi