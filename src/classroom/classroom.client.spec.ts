import { BadGatewayException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MockedFunction, MockInstance } from "vitest";
import { ClassroomClient, type CreateCourseWorkInput } from "./classroom.client.js";
import { ClassroomNotConnectedError, ClassroomPermissionError } from "./classroom.errors.js";

const TOKEN = "ya29.fake-access-token";
const BASE = "https://classroom.googleapis.com/v1";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ClassroomClient", () => {
	let client: ClassroomClient;
	let fetchMock: MockedFunction<typeof fetch>;
	let errorLog: MockInstance<Logger["error"]>;

	const requestOf = (call = 0) => {
		const [url, init] = fetchMock.mock.calls[call] ?? [];
		const parsed = new URL(typeof url === "string" ? url : "http://invalid");
		return {
			url: parsed,
			init: init ?? {},
			headers: (init?.headers ?? {}) as Record<string, string>,
		};
	};

	beforeEach(async () => {
		fetchMock = vi.fn() as unknown as MockedFunction<typeof fetch>;
		vi.stubGlobal("fetch", fetchMock);
		errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

		const module = await Test.createTestingModule({ providers: [ClassroomClient] }).compile();
		client = module.get(ClassroomClient);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe("listCourses", () => {
		it("should ask for the active courses the user teaches with the bearer token", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ courses: [{ id: "1", name: "Math" }] }));

			const courses = await client.listCourses(TOKEN);

			expect(courses).toEqual([{ id: "1", name: "Math" }]);
			const { url, init, headers } = requestOf();
			expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/courses`);
			expect(url.searchParams.get("teacherId")).toBe("me");
			expect(url.searchParams.get("courseStates")).toBe("ACTIVE");
			expect(url.searchParams.get("pageSize")).toBe("50");
			expect(init.method).toBe("GET");
			expect(init.body).toBeUndefined();
			expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
		});

		it.each([
			["courses is missing", {}],
			["courses is empty", { courses: [] }],
		])("should return an empty array when %s", async (_label, body) => {
			fetchMock.mockResolvedValue(jsonResponse(body));

			await expect(client.listCourses(TOKEN)).resolves.toEqual([]);
		});

		it("should return an empty array when Google answers 404", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}, 404));

			await expect(client.listCourses(TOKEN)).resolves.toEqual([]);
		});
	});

	describe("error mapping", () => {
		it("should throw ClassroomNotConnectedError when Google answers 401", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}, 401));

			await expect(client.listCourses(TOKEN)).rejects.toThrow(ClassroomNotConnectedError);
		});

		it("should throw ClassroomPermissionError when Google answers 403", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}, 403));

			await expect(client.listCourses(TOKEN)).rejects.toThrow(ClassroomPermissionError);
		});

		it.each([400, 429, 500, 503])(
			"should throw BadGatewayException and log only the path when Google answers %i",
			async (status) => {
				fetchMock.mockResolvedValue(jsonResponse({ secret: "student@school.example" }, status));

				await expect(client.getCourse(TOKEN, "c1")).rejects.toThrow(BadGatewayException);
				const logged = errorLog.mock.calls.map((call) => call.join(" ")).join("\n");
				expect(logged).toContain(`/v1/courses/c1 failed with ${status}`);
				expect(logged).not.toContain("student@school.example");
				expect(logged).not.toContain(TOKEN);
			},
		);

		it.each([
			["a TypeError", new TypeError("fetch failed")],
			["a non-Error", "boom"],
		])("should throw ServiceUnavailableException when fetch rejects with %s", async (_label, error) => {
			fetchMock.mockRejectedValue(error);

			await expect(client.getCourse(TOKEN, "c1")).rejects.toThrow(ServiceUnavailableException);
		});
	});

	describe("getCourse", () => {
		it("should return the course when it exists", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: "c1", name: "Math" }));

			await expect(client.getCourse(TOKEN, "c1")).resolves.toEqual({ id: "c1", name: "Math" });
		});

		it("should return null when the course does not exist", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}, 404));

			await expect(client.getCourse(TOKEN, "missing")).resolves.toBeNull();
		});

		it("should url-encode the course id", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: "x" }));

			await client.getCourse(TOKEN, "a/../b?c");

			expect(requestOf().url.pathname).toBe("/v1/courses/a%2F..%2Fb%3Fc");
		});
	});

	describe("listStudentNames", () => {
		it("should ask Google only for the student names", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ students: [] }));

			await client.listStudentNames(TOKEN, "c1");

			const { url } = requestOf();
			expect(url.pathname).toBe("/v1/courses/c1/students");
			expect(url.searchParams.get("fields")).toBe("students(profile(name)),nextPageToken");
			expect(url.searchParams.get("pageSize")).toBe("100");
			expect(url.searchParams.has("pageToken")).toBe(false);
		});

		it("should follow every page when there is a next page token", async () => {
			fetchMock
				.mockResolvedValueOnce(
					jsonResponse({
						students: [{ profile: { name: { givenName: "Ana" } } }],
						nextPageToken: "page-2",
					}),
				)
				.mockResolvedValueOnce(
					jsonResponse({ students: [{ profile: { name: { givenName: "Bruno" } } }] }),
				);

			const names = await client.listStudentNames(TOKEN, "c1");

			expect(names).toEqual([{ givenName: "Ana" }, { givenName: "Bruno" }]);
			expect(requestOf(1).url.searchParams.get("pageToken")).toBe("page-2");
		});

		it("should stop paging at 1000 students", async () => {
			const page = (next: string) =>
				jsonResponse({
					students: Array.from({ length: 100 }, () => ({ profile: { name: { givenName: "A" } } })),
					nextPageToken: next,
				});
			fetchMock.mockImplementation(async () => page("more"));

			const names = await client.listStudentNames(TOKEN, "c1");

			expect(names).toHaveLength(1000);
			expect(fetchMock).toHaveBeenCalledTimes(10);
		});

		it("should use an empty name when a student has no profile", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ students: [{}, { profile: {} }] }));

			await expect(client.listStudentNames(TOKEN, "c1")).resolves.toEqual([{}, {}]);
		});

		it("should return an empty array when the class has no students", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await expect(client.listStudentNames(TOKEN, "c1")).resolves.toEqual([]);
		});

		it("should return null when the course does not exist", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}, 404));

			await expect(client.listStudentNames(TOKEN, "missing")).resolves.toBeNull();
		});
	});

	describe("listCourseWork", () => {
		it("should ask for published and draft coursework, newest first", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ courseWork: [{ id: "w1", title: "HW" }] }));

			const work = await client.listCourseWork(TOKEN, "c1");

			expect(work).toEqual([{ id: "w1", title: "HW" }]);
			const { url } = requestOf();
			expect(url.pathname).toBe("/v1/courses/c1/courseWork");
			expect(url.searchParams.getAll("courseWorkStates")).toEqual(["PUBLISHED", "DRAFT"]);
			expect(url.searchParams.get("orderBy")).toBe("updateTime desc");
			expect(url.searchParams.get("pageSize")).toBe("20");
		});

		it("should return an empty array when there is no coursework", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await expect(client.listCourseWork(TOKEN, "c1")).resolves.toEqual([]);
		});

		it("should return null when the course does not exist", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}, 404));

			await expect(client.listCourseWork(TOKEN, "missing")).resolves.toBeNull();
		});
	});

	describe("createCourseWork", () => {
		const input: CreateCourseWorkInput = {
			title: "Homework",
			workType: "ASSIGNMENT",
			state: "DRAFT",
		};

		it("should POST the coursework as JSON when creating it", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: "w1", title: "Homework", state: "DRAFT" }));

			const created = await client.createCourseWork(TOKEN, "c1", input);

			expect(created).toEqual({ id: "w1", title: "Homework", state: "DRAFT" });
			const { url, init, headers } = requestOf();
			expect(url.pathname).toBe("/v1/courses/c1/courseWork");
			expect(init.method).toBe("POST");
			expect(headers["content-type"]).toBe("application/json");
			expect(JSON.parse(init.body as string)).toEqual(input);
		});

		it("should return null when the course does not exist", async () => {
			fetchMock.mockResolvedValue(jsonResponse({}, 404));

			await expect(client.createCourseWork(TOKEN, "missing", input)).resolves.toBeNull();
		});
	});
});
