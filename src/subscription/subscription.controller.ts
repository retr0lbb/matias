import { Authenticate, CurrentUser, Public } from "@nestjs/authentication";
import { Body, Controller, Get, Post } from "@nestjs/common";
import { type User } from "../db/schemas/user.js";
import { ZodValidationPipe } from "../shared/pipes/zodValidationPipe.js";
import { type SubscribeDTO, subscribeSchema } from "./dto/create-subscription.dto.js";
import { SubscriptionService } from "./subscription.service.js";

@Controller("subscription")
export class SubscriptionController {
	constructor(private readonly subService: SubscriptionService) {}

	@Authenticate({ verifiedEmail: true })
	@Post("")
	async subscribe(
		@CurrentUser() user: User,
		@Body(new ZodValidationPipe(subscribeSchema)) body: SubscribeDTO,
	) {
		return await this.subService.createSubscription(user, body);
	}

	@Public()
	@Get("/plans")
	async getPlans() {
		return this.subService.listPlans();
	}
}
