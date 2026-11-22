import { CurrentUser } from "@nestjs/authentication";
import { Controller, Delete, Get, HttpCode } from "@nestjs/common";
import type { User } from "../db/schemas/user.js";
import {
	type ClassroomConnectionStatus,
	GoogleIntegrationService,
} from "./google-integration.service.js";

/**
 * Connection status and disconnect. Connecting is a browser redirect:
 * `GET /auth/oidc/google-classroom/connect` (see OidcController).
 */
@Controller("classroom")
export class ClassroomController {
	constructor(private readonly integration: GoogleIntegrationService) {}

	@Get("status")
	status(@CurrentUser() user: User): Promise<ClassroomConnectionStatus> {
		return this.integration.status(user.id);
	}

	@Delete("connection")
	@HttpCode(200)
	async disconnect(@CurrentUser() user: User): Promise<{ disconnected: boolean }> {
		return { disconnected: await this.integration.disconnect(user.id) };
	}
}
