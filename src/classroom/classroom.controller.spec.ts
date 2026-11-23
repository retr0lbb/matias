import { Test } from "@nestjs/testing";
import type { MockedFunction } from "vitest";
import type { User } from "../db/schemas/user.js";
import { ClassroomController } from "./classroom.controller.js";
import { GoogleIntegrationService } from "./google-integration.service.js";

const USER = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as User;

const createIntegrationMock = () => ({
	status: vi.fn() as unknown as MockedFunction<GoogleIntegrationService["status"]>,
	disconnect: vi.fn() as unknown as MockedFunction<GoogleIntegrationService["disconnect"]>,
});

describe("ClassroomController", () => {
	let controller: ClassroomController;
	let integration: ReturnType<typeof createIntegrationMock>;

	beforeEach(async () => {
		integration = createIntegrationMock();

		const module = await Test.createTestingModule({
			controllers: [ClassroomController],
			providers: [{ provide: GoogleIntegrationService, useValue: integration }],
		}).compile();

		controller = module.get(ClassroomController);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("status", () => {
		it("should return the connection status of the current user", async () => {
			const status = { connected: true, email: "t@school.example", connectedAt: new Date() };
			integration.status.mockResolvedValue(status);

			await expect(controller.status(USER)).resolves.toBe(status);
			expect(integration.status).toHaveBeenCalledWith(USER.id);
		});

		it("should propagate the error when the lookup fails", async () => {
			integration.status.mockRejectedValue(new Error("db down"));

			await expect(controller.status(USER)).rejects.toThrow("db down");
		});
	});

	describe("disconnect", () => {
		it.each([true, false])(
			"should report disconnected=%s from the service",
			async (disconnected) => {
				integration.disconnect.mockResolvedValue(disconnected);

				await expect(controller.disconnect(USER)).resolves.toEqual({ disconnected });
				expect(integration.disconnect).toHaveBeenCalledWith(USER.id);
			},
		);

		it("should propagate the error when disconnecting fails", async () => {
			integration.disconnect.mockRejectedValue(new Error("db down"));

			await expect(controller.disconnect(USER)).rejects.toThrow("db down");
		});
	});
});
