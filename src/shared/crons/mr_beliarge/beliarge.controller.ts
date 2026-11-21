import { Controller, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { MrBeliargeService } from "./beliarge.service.js";

@Controller()
export class MrBeliargeController {
	constructor(private readonly beliargeService: MrBeliargeService) {}

	@Cron("*/10 * * * * *", {
		name: "Mr Beliarge Rent Control",
		timeZone: "America/Sao_Paulo",
	})
	async handleRentControl() {
		Logger.log(`CRONJOB MR BELIARGE INICIADO`);
		await this.beliargeService.getUnpaidRents();
		Logger.log(`CRONJOB MR BELIARGE ENCERRADO`);
	}
}
