import { Authenticate, CurrentUser } from "@nestjs/authentication";
import { Body, Controller, Post } from "@nestjs/common";
import { type User } from "../db/schemas/user.js";
import { SubscriptionService } from "./subscription.service.js";

@Controller("subscription")
export class SubscriptionController {
	constructor(private readonly subService: SubscriptionService) {}

	@Authenticate({ verifiedEmail: true })
	@Post("")
	async subscribe(
		@CurrentUser() user: User,
		@Body() body: { planId: string; discountCode: string },
	) {
		await this.subService.createSubscription(user, body);
	}
}
