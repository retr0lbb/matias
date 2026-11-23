import {
	AuthenticationRegistry,
	SessionCookieProvider,
	SessionRecord,
} from "@nestjs/authentication";
import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { User, userTable } from "../../db/schemas/user.js";

@Injectable()
export class SessionAuth extends SessionCookieProvider<User> {
	constructor(
		@InjectDrizzle() private readonly db: NodePgDatabase,
		registry: AuthenticationRegistry,
	) {
		super();
		registry.registerProvider(this);
	}

	protected async validate(session: SessionRecord): Promise<User | undefined> {
		const [user] = await this.db.select().from(userTable).where(eq(userTable.id, session.userId));
		return user;
	}
}
