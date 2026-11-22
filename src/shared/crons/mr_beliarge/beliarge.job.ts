import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { MrBeliargeService } from "./beliarge.service.js";

@Injectable()
export class MrBeliargeJob {
	private readonly logger = new Logger(MrBeliargeJob.name);
	private running = false;

	constructor(private readonly beliargeService: MrBeliargeService) {}

	/** Every day at 03:00, São Paulo time. */
	@Cron("0 0 3 * * *", { name: "mr-beliarge-rent-control", timeZone: "America/Sao_Paulo" })
	async handleRentControl(): Promise<void> {
		if (this.running) {
			this.logger.warn("Previous run still in progress; skipping this tick");
			return;
		}

		this.running = true;
		try {
			const { checked, deactivated, failed } = await this.beliargeService.run();
			this.logger.log(`Checked ${checked}, deactivated ${deactivated}, failed ${failed}`);
		} catch (error) {
			this.logger.error(
				`Run failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.running = false;
		}
	}
}
