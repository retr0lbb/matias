import type { FunctionDeclaration } from "@google/genai";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { and, desc, eq } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { assessmentsTable } from "../db/schemas/document.js";
import { AssessmentsService } from "../documents/documents.service.js";
import type { ToolResult, ToolRuntime } from "../shared/tools/tool-runtime.js";
import {
	ClassroomClient,
	type ClassroomCourse,
	type ClassroomCourseWork,
	type CreateCourseWorkInput,
	type StudentName,
} from "./classroom.client.js";
import { ClassroomNotConnectedError, ClassroomPermissionError } from "./classroom.errors.js";
import { CLASSROOM_TOOL_NAMES, type ClassroomToolName } from "./classroom-tool-names.js";
import { DriveClient } from "./drive.client.js";
import { GoogleIntegrationService } from "./google-integration.service.js";

/** São Paulo has been UTC-3 all year since 2019 (no daylight saving). */
const SAO_PAULO_OFFSET_HOURS = 3;
const DEFAULT_DUE_TIME = "23:59";
/** Assessments of the conversation listed in the prompt, newest first. */
const MAX_LISTED_ASSESSMENTS = 10;

const courseIdArgs = z.object({ courseId: z.string().trim().min(1).max(64) });

const createAssignmentArgs = z
	.object({
		courseId: z.string().trim().min(1).max(64),
		title: z.string().trim().min(1).max(300),
		description: z.string().trim().max(5000).optional(),
		dueDate: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.optional(),
		dueTime: z
			.string()
			.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
			.optional(),
		maxPoints: z.number().int().min(0).max(1000).optional(),
		assessmentId: z.uuid().optional(),
	})
	.refine((args) => !args.dueTime || args.dueDate, {
		message: "dueTime needs a dueDate",
		path: ["dueTime"],
	});

const COURSE_ID_SCHEMA = {
	type: "object",
	properties: { courseId: { type: "string", description: "Course id from classroom_list_courses." } },
	required: ["courseId"],
};

const DECLARATIONS: Record<ClassroomToolName, FunctionDeclaration> = {
	classroom_list_courses: {
		name: "classroom_list_courses",
		description: "Lists the active Google Classroom classes the teacher teaches.",
		parametersJsonSchema: { type: "object", properties: {} },
	},
	classroom_get_course: {
		name: "classroom_get_course",
		description: "Gets one Google Classroom class and its number of students.",
		parametersJsonSchema: COURSE_ID_SCHEMA,
	},
	classroom_list_students: {
		name: "classroom_list_students",
		description:
			"Number of students in a class and their first name plus last initial. Emails are never available.",
		parametersJsonSchema: COURSE_ID_SCHEMA,
	},
	classroom_list_coursework: {
		name: "classroom_list_coursework",
		description: "The latest 20 assignments of a class (published and drafts).",
		parametersJsonSchema: COURSE_ID_SCHEMA,
	},
	classroom_create_assignment: {
		name: "classroom_create_assignment",
		description:
			"Creates an assignment in a class as a DRAFT the teacher reviews and publishes in Classroom. " +
			"Pass assessmentId to attach a generated assessment as a PDF.",
		parametersJsonSchema: {
			type: "object",
			properties: {
				courseId: { type: "string", description: "Course id from classroom_list_courses." },
				title: { type: "string" },
				description: { type: "string", description: "Instructions for the students." },
				dueDate: { type: "string", description: "YYYY-MM-DD, São Paulo time. Must be in the future." },
				dueTime: { type: "string", description: "HH:mm, São Paulo time. Defaults to 23:59." },
				maxPoints: { type: "integer", description: "0 to 1000. Leave out for ungraded." },
				assessmentId: {
					type: "string",
					description: "Id of an assessment listed in the system prompt, to attach as PDF.",
				},
			},
			required: ["courseId", "title"],
		},
	},
};

export interface ConversationAssessment {
	id: string;
	title: string;
}

/** Thrown inside a tool to answer `{ error: code }`. */
class ToolError extends Error {
	constructor(
		readonly code: string,
		readonly detail?: string,
	) {
		super(code);
	}
}

/**
 * The Classroom tools for one user and turn. Results are kept small and free
 * of student contact data: names are cut to "Given L.", and nothing a tool
 * reads or returns is logged.
 */
@Injectable()
export class ClassroomToolsService {
	private readonly logger = new Logger(ClassroomToolsService.name);

	constructor(
		@InjectDrizzle() private readonly db: NodePgDatabase,
		private readonly integration: GoogleIntegrationService,
		private readonly classroom: ClassroomClient,
		private readonly drive: DriveClient,
		private readonly assessments: AssessmentsService,
	) {}

	isConnected(userId: string): Promise<boolean> {
		return this.integration.isConnected(userId);
	}

	/** Assessments of the conversation the model may attach, newest first. */
	async listConversationAssessments(
		userId: string,
		conversationId: string,
	): Promise<ConversationAssessment[]> {
		const rows = await this.db
			.select({ id: assessmentsTable.id, document: assessmentsTable.document })
			.from(assessmentsTable)
			.where(
				and(eq(assessmentsTable.userId, userId), eq(assessmentsTable.conversationId, conversationId)),
			)
			.orderBy(desc(assessmentsTable.createdAt))
			.limit(MAX_LISTED_ASSESSMENTS);

		return rows.map((row) => ({ id: row.id, title: row.document?.content?.title ?? "Sem título" }));
	}

	/** A runtime offering only `names` (unknown names are dropped). */
	forUser(userId: string, names: readonly string[]): ToolRuntime {
		const offered = CLASSROOM_TOOL_NAMES.filter((name) => names.includes(name));
		let token: Promise<string> | undefined;
		// One token lookup per turn, shared by every call of the turn.
		const accessToken = () => {
			token ??= this.integration.getAccessToken(userId);
			return token;
		};

		return {
			declarations: offered.map((name) => DECLARATIONS[name]),
			execute: async (name, args) => {
				if (!(offered as readonly string[]).includes(name)) {
					return { error: "UNKNOWN_TOOL" };
				}
				try {
					return await this.run(name as ClassroomToolName, args, userId, accessToken);
				} catch (error) {
					return this.toErrorResult(name, error);
				}
			},
		};
	}

	private async run(
		name: ClassroomToolName,
		args: Record<string, unknown>,
		userId: string,
		accessToken: () => Promise<string>,
	): Promise<ToolResult> {
		switch (name) {
			case "classroom_list_courses": {
				const courses = await this.classroom.listCourses(await accessToken());
				return { courses: courses.map(toCourseSummary) };
			}
			case "classroom_get_course": {
				const { courseId } = courseIdArgs.parse(args);
				const token = await accessToken();
				const course = found(await this.classroom.getCourse(token, courseId), "course");
				const students = found(await this.classroom.listStudentNames(token, courseId), "course");
				return {
					...toCourseSummary(course),
					descriptionHeading: course.descriptionHeading ?? null,
					studentCount: students.length,
				};
			}
			case "classroom_list_students": {
				const { courseId } = courseIdArgs.parse(args);
				const names = found(
					await this.classroom.listStudentNames(await accessToken(), courseId),
					"course",
				);
				return { count: names.length, students: names.map(maskStudentName) };
			}
			case "classroom_list_coursework": {
				const { courseId } = courseIdArgs.parse(args);
				const work = found(
					await this.classroom.listCourseWork(await accessToken(), courseId),
					"course",
				);
				return { coursework: work.map(toCourseWorkSummary) };
			}
			case "classroom_create_assignment":
				return this.createAssignment(createAssignmentArgs.parse(args), userId, accessToken);
		}
	}

	private async createAssignment(
		args: z.infer<typeof createAssignmentArgs>,
		userId: string,
		accessToken: () => Promise<string>,
	): Promise<ToolResult> {
		const due = args.dueDate ? toClassroomDue(args.dueDate, args.dueTime ?? DEFAULT_DUE_TIME) : null;
		if (due && due.at.getTime() <= Date.now()) {
			throw new ToolError("INVALID_ARGS", "dueDate must be in the future");
		}

		// Rendered before any Google call: a wrong id fails without side effects.
		let pdf: { filename: string; pdf: Buffer } | undefined;
		if (args.assessmentId) {
			try {
				pdf = await this.assessments.renderPdf(args.assessmentId, userId);
			} catch (error) {
				if (error instanceof NotFoundException) throw new ToolError("NOT_FOUND", "assessment");
				throw error;
			}
		}

		const token = await accessToken();
		const input: CreateCourseWorkInput = {
			title: args.title,
			workType: "ASSIGNMENT",
			state: "DRAFT",
			...(args.description && { description: args.description }),
			...(args.maxPoints !== undefined && { maxPoints: args.maxPoints }),
			...(due && { dueDate: due.date, dueTime: due.time }),
		};

		if (pdf) {
			const file = await this.drive.uploadPdf(token, pdf.filename, pdf.pdf);
			input.materials = [{ driveFile: { driveFile: { id: file.id }, shareMode: "VIEW" } }];
		}

		const created = found(await this.classroom.createCourseWork(token, args.courseId, input), "course");

		return {
			id: created.id,
			title: created.title,
			state: created.state ?? "DRAFT",
			link: created.alternateLink ?? null,
			attached: Boolean(pdf),
		};
	}

	private toErrorResult(name: string, error: unknown): ToolResult {
		if (error instanceof ToolError) {
			return error.detail ? { error: error.code, detail: error.detail } : { error: error.code };
		}
		if (error instanceof z.ZodError) {
			return {
				error: "INVALID_ARGS",
				detail: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
			};
		}
		if (error instanceof ClassroomNotConnectedError) return { error: "NOT_CONNECTED" };
		if (error instanceof ClassroomPermissionError) return { error: "PERMISSION_DENIED" };

		// Only the tool name and our own error message: never arguments or results.
		this.logger.error(
			`Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { error: "UNAVAILABLE" };
	}
}

function found<T>(value: T | null, what: string): T {
	if (value === null) throw new ToolError("NOT_FOUND", what);
	return value;
}

function toCourseSummary(course: ClassroomCourse) {
	return {
		id: course.id,
		name: course.name,
		section: course.section ?? null,
		room: course.room ?? null,
		link: course.alternateLink ?? null,
	};
}

function toCourseWorkSummary(work: ClassroomCourseWork) {
	return {
		id: work.id,
		title: work.title,
		state: work.state ?? null,
		dueDate: work.dueDate
			? `${work.dueDate.year}-${pad(work.dueDate.month)}-${pad(work.dueDate.day)}`
			: null,
		maxPoints: work.maxPoints ?? null,
		link: work.alternateLink ?? null,
	};
}

/** "Ana S." from the name parts; the full family name never leaves the server. */
export function maskStudentName(name: StudentName): string {
	const fullParts = (name.fullName ?? "").trim().split(/\s+/).filter(Boolean);
	const given = name.givenName?.trim().split(/\s+/)[0] || fullParts[0];
	const family = name.familyName?.trim() || (fullParts.length > 1 ? fullParts.at(-1) : "");

	if (!given) return "Aluno(a)";
	return family ? `${given} ${family[0]?.toUpperCase()}.` : given;
}

/** A São Paulo date and time as the UTC `dueDate`/`dueTime` Classroom expects. */
export function toClassroomDue(date: string, time: string) {
	const [year, month, day] = date.split("-").map(Number) as [number, number, number];
	const [hours, minutes] = time.split(":").map(Number) as [number, number];
	const at = new Date(Date.UTC(year, month - 1, day, hours + SAO_PAULO_OFFSET_HOURS, minutes));

	// Date.UTC rolls 2026-02-31 over to March: refuse instead of moving the date.
	const local = new Date(at.getTime() - SAO_PAULO_OFFSET_HOURS * 3_600_000);
	if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) {
		throw new ToolError("INVALID_ARGS", "dueDate is not a real date");
	}

	return {
		at,
		date: { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() },
		time: { hours: at.getUTCHours(), minutes: at.getUTCMinutes() },
	};
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
