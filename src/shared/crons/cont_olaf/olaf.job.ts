import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { CountOlafService } from "./olaf.service.js";

@Injectable()
export class CountOlafJob {
	private readonly logger = new Logger(CountOlafJob.name);
	private running = false;

	constructor(private readonly olafService: CountOlafService) {}

	/** Every 30 minutes. */
	@Cron("0 */30 * * * *", { name: "count-olaf-asaas-sync", timeZone: "America/Sao_Paulo" })
	async handleSync(): Promise<void> {
		if (this.running) {
			this.logger.warn("Previous run still in progress; skipping this tick");
			return;
		}

		this.running = true;
		try {
			const { checked, activated, deactivated, chargesWritten, failed } =
				await this.olafService.run();
			this.logger.log(
				`Checked ${checked}, activated ${activated}, deactivated ${deactivated}, charges written ${chargesWritten}, failed ${failed}`,
			);
		} catch (error) {
			this.logger.error(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.running = false;
		}
	}
}
