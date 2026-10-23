import { AuthenticationRegistry, SessionCookieProvider, SessionRecord } from "@nestjs/authentication";
import { Injectable } from "@nestjs/common";
import { User, userTable } from "../../db/schemas/user.js";
import { InjectDrizzle } from "@nestjs/drizzle";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { error } from "console";


@Injectable()
export class SessionAuth extends SessionCookieProvider<User>{
    constructor(
        @InjectDrizzle() private readonly db: NodePgDatabase,
        registry: AuthenticationRegistry
    ){
        super()
        registry.registerProvider(this)
    }

    protected async validate(session: SessionRecord): Promise<{ id: string; name: string; email: string; emailVerified: boolean | null; passwordHash: string | null; loginProvider: "LOCAL" | "GOOGLE"; } | { id: string; name: string; email: string; emailVerified: boolean | null; passwordHash: string | null; loginProvider: "LOCAL" | "GOOGLE"; } | null | undefined> {
        const [user] = await this.db.select().from(userTable).where(
            eq(userTable.id, session.id)
        )
        return user
    }
}