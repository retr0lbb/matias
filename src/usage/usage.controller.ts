import { Controller, Get } from "@nestjs/common";
import { Authenticate, CurrentUser } from "@nestjs/authentication";
import { type User } from "../db/schemas/user.js";
import { UsageService } from "./usage.service.js";

@Authenticate()
@Controller("usage")
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get()
  getUsage(@CurrentUser() user: User) {
    return this.usageService.getUsage(user);
  }
}
