/** The user has no usable Google connection: never connected, revoked, or the token was refused. */
export class ClassroomNotConnectedError extends Error {
	constructor(message = "Google Classroom is not connected") {
		super(message);
		this.name = "ClassroomNotConnectedError";
	}
}

/** Google refused the call (403): missing scope, not a teacher of the course, domain policy. */
export class ClassroomPermissionError extends Error {
	constructor(message = "Google refused the request") {
		super(message);
		this.name = "ClassroomPermissionError";
	}
}
