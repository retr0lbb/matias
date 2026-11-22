import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MockedFunction, MockInstance } from "vitest";
import { MrBeliargeJob } from "./beliarge.job.js";
import { type BeliargeSummary, MrBeliargeService } from "./beliarge.service.js";

const createServiceMock = () => ({
	run: vi.fn() as unknown as MockedFunction<MrBeliargeService["run"]>,
});

const SUMMARY: BeliargeSummary = { checked: 3, deactivated: 2, failed: 1 };

describe("MrBeliargeJob", () => {
	let job: MrBeliargeJob;
	let service: ReturnType<typeof createServiceMock>;
	let infoLog: MockInstance<Logger["log"]>;
	let warnLog: MockInstance<Logger["warn"]>;
	let errorLog: MockInstance<Logger["error"]>;

	beforeEach(async () => {
		service = createServiceMock();
		infoLog = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
		warnLog = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
		errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

		const module = await Test.createTestingModule({
			providers: [MrBeliargeJob, { provide: MrBeliargeService, useValue: service }],
		}).compile();

		job = module.get(MrBeliargeJob);
		// Drops what Nest itself logged while compiling the module.
		infoLog.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe("handleRentControl", () => {
		it("should log the summary when the run succeeds", async () => {
			service.run.mockResolvedValue(SUMMARY);

			await job.handleRentControl();

			expect(service.run).toHaveBeenCalledTimes(1);
			expect(infoLog.mock.calls[0]?.join(" ")).toContain("Checked 3, deactivated 2, failed 1");
		});

		it("should log the error and not throw when the run fails", async () => {
			service.run.mockRejectedValue(new Error("connection lost"));

			await expect(job.handleRentControl()).resolves.toBeUndefined();

			expect(errorLog.mock.calls[0]?.join(" ")).toContain("connection lost");
		});

		it("should log a non-Error rejection when the run fails", async () => {
			service.run.mockRejectedValue("boom");

			await job.handleRentControl();

			expect(errorLog.mock.calls[0]?.join(" ")).toContain("boom");
		});

		it("should skip the tick when the previous run is still in progress", async () => {
			let finish: (summary: BeliargeSummary) => void = () => undefined;
			service.run.mockReturnValue(new Promise((resolve) => (finish = resolve)));

			const first = job.handleRentControl();
			await job.handleRentControl();
			finish(SUMMARY);
			await first;

			expect(service.run).toHaveBeenCalledTimes(1);
			expect(warnLog.mock.calls[0]?.join(" ")).toContain("skipping");
		});

		it("should run again when the previous run failed", async () => {
			service.run.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(SUMMARY);

			await job.handleRentControl();
			await job.handleRentControl();

			expect(service.run).toHaveBeenCalledTimes(2);
		});
	});
});
