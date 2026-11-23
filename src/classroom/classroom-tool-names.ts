/** Classroom tools the judge can pick and Gemini can call (underscores: Gemini-safe names). */
export const CLASSROOM_TOOL_NAMES = [
	"classroom_list_courses",
	"classroom_get_course",
	"classroom_list_students",
	"classroom_list_coursework",
	"classroom_create_assignment",
] as const;

export type ClassroomToolName = (typeof CLASSROOM_TOOL_NAMES)[number];

/** One line per tool, for the judge prompt. */
export const CLASSROOM_TOOL_SUMMARIES: Record<ClassroomToolName, string> = {
	classroom_list_courses: "lists the teacher's active Google Classroom classes",
	classroom_get_course: "details of one Google Classroom class",
	classroom_list_students: "how many students a class has, and their first names",
	classroom_list_coursework: "the latest assignments of a class",
	classroom_create_assignment:
		"creates a draft assignment (homework) in a class, optionally attaching a generated assessment",
};
