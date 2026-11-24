import { Public } from "@nestjs/authentication";
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
	@Public()
	@Get()
	check() {
		return { ok: true };
	}
}
