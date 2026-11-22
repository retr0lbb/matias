import { Injectable } from "@nestjs/common";
import { googleRequest } from "./google-http.js";

const BASE_URL = "https://classroom.googleapis.com/v1";
const STUDENTS_PAGE_SIZE = 100;
/** Stops paging a roster past this many students. */
const MAX_STUDENTS = 1000;
const COURSEWORK_PAGE_SIZE = 20;

export interface ClassroomCourse {
	id: string;
	name: string;
	section?: string;
	descriptionHeading?: string;
	room?: string;
	courseState?: string;
	alternateLink?: string;
}

export interface ClassroomDate {
	year: number;
	month: number;
	day: number;
}

export interface ClassroomTime {
	hours?: number;
	minutes?: number;
}

export interface ClassroomCourseWork {
	id: string;
	title: string;
	state?: string;
	workType?: string;
	maxPoints?: number;
	dueDate?: ClassroomDate;
	dueTime?: ClassroomTime;
	alternateLink?: string;
}

/** Only the name: the request asks Google for nothing else (field mask). */
export interface StudentName {
	givenName?: string;
	familyName?: string;
	fullName?: string;
}

export interface CreateCourseWorkInput {
	title: string;
	description?: string;
	workType: "ASSIGNMENT";
	state: "DRAFT";
	maxPoints?: number;
	dueDate?: ClassroomDate;
	dueTime?: ClassroomTime;
	materials?: { driveFile: { driveFile: { id: string }; shareMode: "VIEW" } }[];
}

/**
 * Google Classroom REST client. Every call takes the teacher's access token;
 * a course or resource Google does not find comes back as null. See
 * `googleRequest` for the error mapping.
 */
@Injectable()
export class ClassroomClient {
	/** Active courses the user teaches (first 50). */
	async listCourses(accessToken: string): Promise<ClassroomCourse[]> {
		const url = withQuery(`${BASE_URL}/courses`, {
			teacherId: "me",
			courseStates: "ACTIVE",
			pageSize: "50",
		});
		const page = await googleRequest<{ courses?: ClassroomCourse[] }>({
			accessToken,
			method: "GET",
			url,
		});
		return page?.courses ?? [];
	}

	async getCourse(accessToken: string, courseId: string): Promise<ClassroomCourse | null> {
		return googleRequest<ClassroomCourse>({
			accessToken,
			method: "GET",
			url: `${BASE_URL}/courses/${encodeURIComponent(courseId)}`,
		});
	}

	/**
	 * Student names of a course, every page up to MAX_STUDENTS. The field mask
	 * keeps emails, ids and photos from ever reaching us. Null when the course
	 * does not exist.
	 */
	async listStudentNames(accessToken: string, courseId: string): Promise<StudentName[] | null> {
		const names: StudentName[] = [];
		let pageToken: string | undefined;

		do {
			const url = withQuery(`${BASE_URL}/courses/${encodeURIComponent(courseId)}/students`, {
				pageSize: String(STUDENTS_PAGE_SIZE),
				fields: "students(profile(name)),nextPageToken",
				...(pageToken && { pageToken }),
			});
			const page = await googleRequest<{
				students?: { profile?: { name?: StudentName } }[];
				nextPageToken?: string;
			}>({ accessToken, method: "GET", url });

			if (!page) return null;

			for (const student of page.students ?? []) {
				names.push(student.profile?.name ?? {});
			}
			pageToken = page.nextPageToken || undefined;
		} while (pageToken && names.length < MAX_STUDENTS);

		return names.slice(0, MAX_STUDENTS);
	}

	/** The latest coursework of a course (one page). Null when the course does not exist. */
	async listCourseWork(accessToken: string, courseId: string): Promise<ClassroomCourseWork[] | null> {
		// Drafts too: the ones MATIAS created are waiting for the teacher to publish.
		const url = withQuery(`${BASE_URL}/courses/${encodeURIComponent(courseId)}/courseWork`, {
			pageSize: String(COURSEWORK_PAGE_SIZE),
			orderBy: "updateTime desc",
			courseWorkStates: ["PUBLISHED", "DRAFT"],
		});

		const page = await googleRequest<{ courseWork?: ClassroomCourseWork[] }>({
			accessToken,
			method: "GET",
			url,
		});
		return page ? (page.courseWork ?? []) : null;
	}

	async createCourseWork(
		accessToken: string,
		courseId: string,
		input: CreateCourseWorkInput,
	): Promise<ClassroomCourseWork | null> {
		return googleRequest<ClassroomCourseWork>({
			accessToken,
			method: "POST",
			url: `${BASE_URL}/courses/${encodeURIComponent(courseId)}/courseWork`,
			body: input,
		});
	}
}

/** Builds `url?query`; an array value repeats the parameter. */
function withQuery(url: string, query: Record<string, string | string[]>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
	}
	return `${url}?${params.toString()}`;
}
