import { BadGatewayException, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MockedFunction } from "vitest";
import { ClassroomPermissionError } from "./classroom.errors.js";
import { DriveClient } from "./drive.client.js";

const TOKEN = "ya29.fake-access-token";
const PDF = Buffer.from("%PDF-1.7 fake");

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("DriveClient", () => {
	let client: DriveClient;
	let fetchMock: MockedFunction<typeof fetch>;

	beforeEach(async () => {
		fetchMock = vi.fn() as unknown as MockedFunction<typeof fetch>;
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

		const module = await Test.createTestingModule({ providers: [DriveClient] }).compile();
		client = module.get(DriveClient);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe("uploadPdf", () => {
		it("should upload the PDF as a multipart request and return the file", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: "file-1", webViewLink: "https://drive/file-1" }));

			const file = await client.uploadPdf(TOKEN, "prova.pdf", PDF);

			expect(file).toEqual({ id: "file-1", webViewLink: "https://drive/file-1" });
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe(
				"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
			);
			expect(init?.method).toBe("POST");

			const headers = init?.headers as Record<string, string>;
			const boundary = headers["content-type"]?.match(/^multipart\/related; boundary=(.+)$/)?.[1];
			expect(boundary).toMatch(/^matias-/);
			expect(headers.authorization).toBe(`Bearer ${TOKEN}`);

			const body = init?.body as string;
			expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
			expect(body).toContain(JSON.stringify({ name: "prova.pdf", mimeType: "application/pdf" }));
			expect(body).toContain(`Content-Transfer-Encoding: base64\r\n\r\n${PDF.toString("base64")}`);
			expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
		});

		it("should use a new boundary for each upload", async () => {
			fetchMock.mockImplementation(async () => jsonResponse({ id: "file-1" }));

			await client.uploadPdf(TOKEN, "a.pdf", PDF);
			await client.uploadPdf(TOKEN, "b.pdf", PDF);

			const typeOf = (call: number) => {
				const headers = (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
				return headers["content-type"];
			};
			expect(typeOf(0)).not.toBe(typeOf(1));
		});

		it.each([
			["Drive answers 404", () => jsonResponse({}, 404)],
			["the response has no id", () => jsonResponse({ webViewLink: "x" })],
		])("should throw BadGatewayException when %s", async (_label, response) => {
			fetchMock.mockResolvedValue(response());

			await expect(client.uploadPdf(TOKEN, "a.pdf", PDF)).rejects.toThrow(BadGatewayException);
		});

		it("should throw ClassroomPermissionError when Drive answers 403", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}, 403));

			await expect(client.uploadPdf(TOKEN, "a.pdf", PDF)).rejects.toThrow(ClassroomPermissionError);
		});
	});
});
