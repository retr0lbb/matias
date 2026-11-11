import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { User } from "../db/schemas/user.js";

@Injectable()
export class SubscriptionService {
	constructor(@InjectDrizzle() db: NodePgDatabase) {}

	async createSubscription(user: User, payload: { planId: string; discountCode: string }) {}
}
