import { BadGatewayException, Logger, NotFoundException } from "@nestjs/common";
import { getDrizzleToken } from "@nestjs/drizzle";
import { Test } from "@nestjs/testing";
import type { MockedFunction, MockInstance } from "vitest";
import { AssessmentsService } from "../documents/documents.service.js";
import { ClassroomClient } from "./classroom.client.js";
import { ClassroomNotConnectedError, ClassroomPermissionError } from "./classroom.errors.js";
import {
	ClassroomToolsService,
	maskStudentName,
	toClassroomDue,
} from "./classroom-tools.service.js";
import { CLASSROOM_TOOL_NAMES } from "./classroom-tool-names.js";
import { DriveClient } from "./drive.client.js";
import { GoogleIntegrationService } from "./google-integration.service.js";

// 2026-11-22 09:00 in São Paulo.
const NOW = new Date("2026-11-22T12:00:00.000Z");
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSESSMENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "ya29.token";

const createDbMock = () => {
	const chain = {
		from: vi.fn(),
		where: vi.fn(),
		orderBy: vi.fn(),
		limit: vi.fn<() => Promise<unknown[]>>(),
	};
	chain.from.mockReturnValue(chain);
	chain.where.mockReturnValue(chain);
	chain.orderBy.mockReturnValue(chain);
	chain.limit.mockResolvedValue([]);
	return { select: vi.fn(() => chain), chain };
};

const createIntegrationMock = () => ({
	isConnected: vi.fn() as unknown as MockedFunction<GoogleIntegrationService["isConnected"]>,
	getAccessToken: vi.fn() as unknown as MockedFunction<GoogleIntegrationService["getAccessToken"]>,
});

const createClassroomMock = () => ({
	listCourses: vi.fn() as unknown as MockedFunction<ClassroomClient["listCourses"]>,
	getCourse: vi.fn() as unknown as MockedFunction<ClassroomClient["getCourse"]>,
	listStudentNames: vi.fn() as unknown as MockedFunction<ClassroomClient["listStudentNames"]>,
	listCourseWork: vi.fn() as unknown as MockedFunction<ClassroomClient["listCourseWork"]>,
	createCourseWork: vi.fn() as unknown as MockedFunction<ClassroomClient["createCourseWork"]>,
});

const createDriveMock = () => ({
	uploadPdf: vi.fn() as unknown as MockedFunction<DriveClient["uploadPdf"]>,
});

const createAssessmentsMock = () => ({
	renderPdf: vi.fn() as unknown as MockedFunction<AssessmentsService["renderPdf"]>,
});

describe("maskStudentName", () => {
	it.each([
		[{ givenName: "Ana", familyName: "Souza" }, "Ana S."],
		[{ givenName: "Ana Clara", familyName: "souza lima" }, "Ana S."],
		[{ givenName: "  Ana ", familyName: " " }, "Ana"],
		[{ fullName: "Bruno Henrique Costa" }, "Bruno C."],
		[{ fullName: "Bruno" }, "Bruno"],
		[{ familyName: "Souza" }, "Aluno(a)"],
		[{}, "Aluno(a)"],
		[{ givenName: "", fullName: "  " }, "Aluno(a)"],
	])("should turn %j into %j", (name, expected) => {
		expect(maskStudentName(name)).toBe(expected);
	});
});

describe("toClassroomDue", () => {
	it.each([
		["2026-11-30", "10:00", { year: 2026, month: 11, day: 30 }, { hours: 13, minutes: 0 }],
		["2026-11-30", "23:59", { year: 2026, month: 12, day: 1 }, { hours: 2, minutes: 59 }],
		["2026-12-31", "22:30", { year: 2027, month: 1, day: 1 }, { hours: 1, minutes: 30 }],
		["2028-02-29", "00:00", { year: 2028, month: 2, day: 29 }, { hours: 3, minutes: 0 }],
	])("should convert %s %s São Paulo time to UTC", (date, time, expectedDate, expectedTime) => {
		const due = toClassroomDue(date, time);

		expect(due.date).toEqual(expectedDate);
		expect(due.time).toEqual(expectedTime);
	});

	it.each(["2026-02-30", "2026-13-01", "2027-02-29", "2026-00-10"])(
		"should throw when %s is not a real date",
		(date) => {
			expect(() => toClassroomDue(date, "10:00")).toThrow("INVALID_ARGS");
		},
	);
});

describe("ClassroomToolsService", () => {
	let service: ClassroomToolsService;
	let db: ReturnType<typeof createDbMock>;
	let integration: ReturnType<typeof createIntegrationMock>;
	let classroom: ReturnType<typeof createClassroomMock>;
	let drive: ReturnType<typeof createDriveMock>;
	let assessments: ReturnType<typeof createAssessmentsMock>;
	let errorLog: MockInstance<Logger["error"]>;

	const runtime = (names: readonly string[] = CLASSROOM_TOOL_NAMES) =>
		service.forUser(USER_ID, names);

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		db = createDbMock();
		integration = createIntegrationMock();
		classroom = createClassroomMock();
		drive = createDriveMock();
		assessments = createAssessmentsMock();
		errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

		integration.getAccessToken.mockResolvedValue(TOKEN);

		const module = await Test.createTestingModule({
			providers: [
				ClassroomToolsService,
				{ provide: getDrizzleToken(), useValue: db },
				{ provide: GoogleIntegrationService, useValue: integration },
				{ provide: ClassroomClient, useValue: classroom },
				{ provide: DriveClient, useValue: drive },
				{ provide: AssessmentsService, useValue: assessments },
			],
		}).compile();

		service = module.get(ClassroomToolsService);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	describe("isConnected", () => {
		it.each([true, false])("should return %s from the integration", async (connected) => {
			integration.isConnected.mockResolvedValue(connected);

			await expect(service.isConnected(USER_ID)).resolves.toBe(connected);
			expect(integration.isConnected).toHaveBeenCalledWith(USER_ID);
		});
	});

	describe("listConversationAssessments", () => {
		it("should return the id and title of each assessment", async () => {
			db.chain.limit.mockResolvedValue([
				{ id: "a1", document: { content: { title: "Prova de frações" } } },
				{ id: "a2", document: { content: {} } },
				{ id: "a3", document: null },
			]);

			const result = await service.listConversationAssessments(USER_ID, CONVERSATION_ID);

			expect(result).toEqual([
				{ id: "a1", title: "Prova de frações" },
				{ id: "a2", title: "Sem título" },
				{ id: "a3", title: "Sem título" },
			]);
			expect(db.chain.limit).toHaveBeenCalledWith(10);
		});

		it("should return an empty array when the conversation has no assessment", async () => {
			await expect(service.listConversationAssessments(USER_ID, CONVERSATION_ID)).resolves.toEqual(
				[],
			);
		});
	});

	describe("forUser", () => {
		it("should declare only the requested tools, in a stable order", () => {
			const tools = runtime(["classroom_list_students", "classroom_list_courses", "unknown"]);

			expect(tools.declarations.map((declaration) => declaration.name)).toEqual([
				"classroom_list_courses",
				"classroom_list_students",
			]);
		});

		it("should declare nothing when no requested name is known", () => {
			expect(runtime(["nope"]).declarations).toEqual([]);
		});

		it("should answer UNKNOWN_TOOL when the model calls a tool that was not offered", async () => {
			const result = await runtime(["classroom_list_courses"]).execute("classroom_list_students", {
				courseId: "c1",
			});

			expect(result).toEqual({ error: "UNKNOWN_TOOL" });
			expect(classroom.listStudentNames).not.toHaveBeenCalled();
		});

		it("should look up the access token once per turn when several tools run", async () => {
			classroom.listCourses.mockResolvedValue([]);
			const tools = runtime();

			await tools.execute("classroom_list_courses", {});
			await tools.execute("classroom_list_courses", {});

			expect(integration.getAccessToken).toHaveBeenCalledTimes(1);
			expect(integration.getAccessToken).toHaveBeenCalledWith(USER_ID);
		});
	});

	describe("classroom_list_courses", () => {
		it("should return a summary of each course", async () => {
			classroom.listCourses.mockResolvedValue([
				{ id: "c1", name: "Matemática", section: "8A", room: "12", alternateLink: "https://c/1" },
				{ id: "c2", name: "História" },
			]);

			const result = await runtime().execute("classroom_list_courses", {});

			expect(result).toEqual({
				courses: [
					{ id: "c1", name: "Matemática", section: "8A", room: "12", link: "https://c/1" },
					{ id: "c2", name: "História", section: null, room: null, link: null },
				],
			});
			expect(classroom.listCourses).toHaveBeenCalledWith(TOKEN);
		});
	});

	describe("classroom_get_course", () => {
		it("should return the course with its student count", async () => {
			classroom.getCourse.mockResolvedValue({ id: "c1", name: "Matemática", descriptionHeading: "8º ano" });
			classroom.listStudentNames.mockResolvedValue([{ givenName: "Ana" }, { givenName: "Bia" }]);

			const result = await runtime().execute("classroom_get_course", { courseId: "c1" });

			expect(result).toEqual({
				id: "c1",
				name: "Matemática",
				section: null,
				room: null,
				link: null,
				descriptionHeading: "8º ano",
				studentCount: 2,
			});
			expect(JSON.stringify(result)).not.toContain("Ana");
		});

		it("should answer NOT_FOUND when the course does not exist", async () => {
			classroom.getCourse.mockResolvedValue(null);

			const result = await runtime().execute("classroom_get_course", { courseId: "c1" });

			expect(result).toEqual({ error: "NOT_FOUND", detail: "course" });
			expect(classroom.listStudentNames).not.toHaveBeenCalled();
		});

		it("should answer NOT_FOUND when the roster disappeared", async () => {
			classroom.getCourse.mockResolvedValue({ id: "c1", name: "Matemática" });
			classroom.listStudentNames.mockResolvedValue(null);

			await expect(runtime().execute("classroom_get_course", { courseId: "c1" })).resolves.toEqual({
				error: "NOT_FOUND",
				detail: "course",
			});
		});

		it.each([
			["courseId is missing", {}],
			["courseId is empty", { courseId: "  " }],
			["courseId is not a string", { courseId: 12 }],
			["courseId is too long", { courseId: "x".repeat(65) }],
		])("should answer INVALID_ARGS when %s", async (_label, args) => {
			const result = await runtime().execute("classroom_get_course", args);

			expect(result).toMatchObject({ error: "INVALID_ARGS" });
			expect(result.detail).toContain("courseId");
			expect(classroom.getCourse).not.toHaveBeenCalled();
		});
	});

	describe("classroom_list_students", () => {
		it("should return the count and masked names only", async () => {
			classroom.listStudentNames.mockResolvedValue([
				{ givenName: "Ana", familyName: "Souza", fullName: "Ana Souza" },
				{ givenName: "Bruno", familyName: "Lima", fullName: "Bruno Lima" },
			]);

			const result = await runtime().execute("classroom_list_students", { courseId: "c1" });

			expect(result).toEqual({ count: 2, students: ["Ana S.", "Bruno L."] });
			expect(JSON.stringify(result)).not.toMatch(/Souza|Lima/);
		});

		it("should return an empty list when the class has no students", async () => {
			classroom.listStudentNames.mockResolvedValue([]);

			await expect(
				runtime().execute("classroom_list_students", { courseId: "c1" }),
			).resolves.toEqual({ count: 0, students: [] });
		});

		it("should answer NOT_FOUND when the course does not exist", async () => {
			classroom.listStudentNames.mockResolvedValue(null);

			await expect(
				runtime().execute("classroom_list_students", { courseId: "c1" }),
			).resolves.toEqual({ error: "NOT_FOUND", detail: "course" });
		});
	});

	describe("classroom_list_coursework", () => {
		it("should return a summary of each assignment", async () => {
			classroom.listCourseWork.mockResolvedValue([
				{
					id: "w1",
					title: "Lista 1",
					state: "PUBLISHED",
					maxPoints: 10,
					dueDate: { year: 2026, month: 3, day: 5 },
					alternateLink: "https://c/w1",
				},
				{ id: "w2", title: "Rascunho" },
			]);

			const result = await runtime().execute("classroom_list_coursework", { courseId: "c1" });

			expect(result).toEqual({
				coursework: [
					{
						id: "w1",
						title: "Lista 1",
						state: "PUBLISHED",
						dueDate: "2026-03-05",
						maxPoints: 10,
						link: "https://c/w1",
					},
					{ id: "w2", title: "Rascunho", state: null, dueDate: null, maxPoints: null, link: null },
				],
			});
		});

		it("should answer NOT_FOUND when the course does not exist", async () => {
			classroom.listCourseWork.mockResolvedValue(null);

			await expect(
				runtime().execute("classroom_list_coursework", { courseId: "c1" }),
			).resolves.toEqual({ error: "NOT_FOUND", detail: "course" });
		});
	});

	describe("classroom_create_assignment", () => {
		const created = { id: "w9", title: "Lista", state: "DRAFT", alternateLink: "https://c/w9" };

		it("should create a DRAFT assignment with only the given fields", async () => {
			classroom.createCourseWork.mockResolvedValue(created);

			const result = await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "  Lista  ",
			});

			expect(result).toEqual({
				id: "w9",
				title: "Lista",
				state: "DRAFT",
				link: "https://c/w9",
				attached: false,
			});
			expect(classroom.createCourseWork).toHaveBeenCalledWith(TOKEN, "c1", {
				title: "Lista",
				workType: "ASSIGNMENT",
				state: "DRAFT",
			});
			expect(drive.uploadPdf).not.toHaveBeenCalled();
		});

		it("should send the description, points and due date in UTC when given", async () => {
			classroom.createCourseWork.mockResolvedValue(created);

			await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "Lista",
				description: "Resolver 1 a 10",
				maxPoints: 0,
				dueDate: "2026-11-30",
				dueTime: "22:00",
			});

			expect(classroom.createCourseWork.mock.calls[0]?.[2]).toEqual({
				title: "Lista",
				workType: "ASSIGNMENT",
				state: "DRAFT",
				description: "Resolver 1 a 10",
				maxPoints: 0,
				dueDate: { year: 2026, month: 12, day: 1 },
				dueTime: { hours: 1, minutes: 0 },
			});
		});

		it("should default the due time to 23:59 São Paulo time", async () => {
			classroom.createCourseWork.mockResolvedValue(created);

			await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "Lista",
				dueDate: "2026-11-25",
			});

			expect(classroom.createCourseWork.mock.calls[0]?.[2]).toMatchObject({
				dueDate: { year: 2026, month: 11, day: 26 },
				dueTime: { hours: 2, minutes: 59 },
			});
		});

		it("should attach the rendered assessment PDF when an assessmentId is given", async () => {
			const pdf = Buffer.from("%PDF");
			assessments.renderPdf.mockResolvedValue({ filename: "prova.pdf", pdf });
			drive.uploadPdf.mockResolvedValue({ id: "file-1" });
			classroom.createCourseWork.mockResolvedValue(created);

			const result = await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "Prova",
				assessmentId: ASSESSMENT_ID,
			});

			expect(result).toMatchObject({ attached: true });
			expect(assessments.renderPdf).toHaveBeenCalledWith(ASSESSMENT_ID, USER_ID);
			expect(drive.uploadPdf).toHaveBeenCalledWith(TOKEN, "prova.pdf", pdf);
			expect(classroom.createCourseWork.mock.calls[0]?.[2].materials).toEqual([
				{ driveFile: { driveFile: { id: "file-1" }, shareMode: "VIEW" } },
			]);
			expect(drive.uploadPdf.mock.invocationCallOrder[0]).toBeLessThan(
				classroom.createCourseWork.mock.invocationCallOrder[0] ?? 0,
			);
		});

		it("should answer NOT_FOUND without calling Google when the assessment is not the user's", async () => {
			assessments.renderPdf.mockRejectedValue(new NotFoundException("Assessment not found"));

			const result = await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "Prova",
				assessmentId: ASSESSMENT_ID,
			});

			expect(result).toEqual({ error: "NOT_FOUND", detail: "assessment" });
			expect(integration.getAccessToken).not.toHaveBeenCalled();
			expect(classroom.createCourseWork).not.toHaveBeenCalled();
		});

		it("should answer UNAVAILABLE when rendering the PDF fails for another reason", async () => {
			assessments.renderPdf.mockRejectedValue(new Error("chromium crashed"));

			const result = await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "Prova",
				assessmentId: ASSESSMENT_ID,
			});

			expect(result).toEqual({ error: "UNAVAILABLE" });
			expect(classroom.createCourseWork).not.toHaveBeenCalled();
		});

		it.each([
			["the due date is today but already past", { dueDate: "2026-11-22", dueTime: "08:00" }],
			["the due date is in the past", { dueDate: "2026-11-01" }],
			["the due date is now", { dueDate: "2026-11-22", dueTime: "09:00" }],
		])("should answer INVALID_ARGS when %s", async (_label, due) => {
			const result = await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "Lista",
				...due,
			});

			expect(result).toEqual({ error: "INVALID_ARGS", detail: "dueDate must be in the future" });
			expect(classroom.createCourseWork).not.toHaveBeenCalled();
		});

		it("should accept a due time later today", async () => {
			classroom.createCourseWork.mockResolvedValue(created);

			const result = await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "Lista",
				dueDate: "2026-11-22",
				dueTime: "09:01",
			});

			expect(result).toMatchObject({ id: "w9" });
		});

		it.each([
			["the title is missing", { courseId: "c1" }, "title"],
			["the title is blank", { courseId: "c1", title: "   " }, "title"],
			["dueTime comes without dueDate", { courseId: "c1", title: "L", dueTime: "10:00" }, "dueTime"],
			["dueDate is badly formatted", { courseId: "c1", title: "L", dueDate: "30/11/2026" }, "dueDate"],
			["dueTime is badly formatted", { courseId: "c1", title: "L", dueDate: "2026-11-30", dueTime: "24:00" }, "dueTime"],
			["maxPoints is negative", { courseId: "c1", title: "L", maxPoints: -1 }, "maxPoints"],
			["maxPoints is over 1000", { courseId: "c1", title: "L", maxPoints: 1001 }, "maxPoints"],
			["maxPoints is fractional", { courseId: "c1", title: "L", maxPoints: 1.5 }, "maxPoints"],
			["assessmentId is not a uuid", { courseId: "c1", title: "L", assessmentId: "abc" }, "assessmentId"],
		])("should answer INVALID_ARGS when %s", async (_label, args, field) => {
			const result = await runtime().execute("classroom_create_assignment", args);

			expect(result).toMatchObject({ error: "INVALID_ARGS" });
			expect(result.detail).toContain(field);
			expect(classroom.createCourseWork).not.toHaveBeenCalled();
		});

		it("should answer INVALID_ARGS when the due date does not exist", async () => {
			const result = await runtime().execute("classroom_create_assignment", {
				courseId: "c1",
				title: "L",
				dueDate: "2027-02-30",
			});

			expect(result).toEqual({ error: "INVALID_ARGS", detail: "dueDate is not a real date" });
		});

		it("should answer NOT_FOUND when the course does not exist", async () => {
			classroom.createCourseWork.mockResolvedValue(null);

			await expect(
				runtime().execute("classroom_create_assignment", { courseId: "c1", title: "L" }),
			).resolves.toEqual({ error: "NOT_FOUND", detail: "course" });
		});

		it("should fall back to DRAFT and a null link when Google leaves them out", async () => {
			classroom.createCourseWork.mockResolvedValue({ id: "w9", title: "L" });

			await expect(
				runtime().execute("classroom_create_assignment", { courseId: "c1", title: "L" }),
			).resolves.toEqual({ id: "w9", title: "L", state: "DRAFT", link: null, attached: false });
		});
	});

	describe("errors", () => {
		it("should answer NOT_CONNECTED when there is no usable token", async () => {
			integration.getAccessToken.mockRejectedValue(new ClassroomNotConnectedError());

			await expect(runtime().execute("classroom_list_courses", {})).resolves.toEqual({
				error: "NOT_CONNECTED",
			});
		});

		it("should answer NOT_CONNECTED when Google refuses the token", async () => {
			classroom.listCourses.mockRejectedValue(new ClassroomNotConnectedError());

			await expect(runtime().execute("classroom_list_courses", {})).resolves.toEqual({
				error: "NOT_CONNECTED",
			});
		});

		it("should answer PERMISSION_DENIED when Google forbids the call", async () => {
			classroom.listStudentNames.mockRejectedValue(new ClassroomPermissionError());

			await expect(
				runtime().execute("classroom_list_students", { courseId: "c1" }),
			).resolves.toEqual({ error: "PERMISSION_DENIED" });
		});

		it("should answer UNAVAILABLE and log only the tool name when Google fails", async () => {
			classroom.listCourses.mockRejectedValue(new BadGatewayException("Google API error"));

			const result = await runtime().execute("classroom_list_courses", {});

			expect(result).toEqual({ error: "UNAVAILABLE" });
			expect(errorLog.mock.calls[0]?.join(" ")).toBe(
				"Tool classroom_list_courses failed: Google API error",
			);
		});

		it("should answer UNAVAILABLE when something rejects with a non-Error", async () => {
			classroom.listCourses.mockRejectedValue("boom");

			await expect(runtime().execute("classroom_list_courses", {})).resolves.toEqual({
				error: "UNAVAILABLE",
			});
		});
	});
});
