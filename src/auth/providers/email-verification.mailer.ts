import { AuthenticationRegistry, EmailVerificationHandler, EmailVerificationLink } from "@nestjs/authentication";
import { Injectable } from "@nestjs/common";
import { InjectDrizzle } from "@nestjs/drizzle";
import { Mailable, Mailer } from "@nestjs/mail";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { userTable } from "../../db/schemas/user.js";
import { eq } from "drizzle-orm";


@Injectable()
export class VerifyEmailMail implements Mailable<EmailVerificationLink>{
    render({ url }: EmailVerificationLink){
        return {
            subject: "Confirm your email address",
            template: "confirm-mail",
            context: {url}
        }
    }
}

@Injectable()
export class EmailVerificationMailer extends EmailVerificationHandler{
    constructor(
        @InjectDrizzle() private readonly db: NodePgDatabase,
        private readonly mailer: Mailer,
        registry: AuthenticationRegistry
    ){
        super()
        registry.registerHandler("emailVerification", this)
    }

    async send(link: EmailVerificationLink){
        await this.mailer.send(VerifyEmailMail, {to: link.email, data: link})
    }

    async markVerified(userId: string, email: string): Promise<boolean>{
        const [user] = await this.db.select().from(userTable).where(eq(userTable.id, userId))

        if(!user || (user.email !== email)){
            throw new Error("User not found or email dont match")
        }

        await this.db.update(userTable).set({emailVerified: true}).where(eq(userTable.id, userId))
        return true
    }
}