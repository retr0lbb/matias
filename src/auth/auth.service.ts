import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { CredentialService } from '../shared/services/credentials.js';
import { userTable } from '../db/schemas/user.js';
import { eq } from 'drizzle-orm';

@Injectable()
export class AuthService {
    constructor(
        @InjectDrizzle() private readonly db: NodePgDatabase,
        private readonly credSerivice: CredentialService
    ){}

    async createAccount(payload: {email: string, name: string, password: string}){
        const [alreadyExistsWithEmail] = await this.db
            .select()
            .from(userTable)
            .where(
                eq(
                    userTable.email, payload.email
                )
            )
            
        if(alreadyExistsWithEmail){
            throw new Error("Email already exists ")
        }

        const hashedPass = await this.credSerivice.hashPassword(payload.password)

        await this.db
            .insert(userTable)
            .values(
                {
                    email: payload.email,
                    name: payload.name,
                    emailVerified: false,
                    loginProvider: "LOCAL",
                    passwordHash: hashedPass
                }
            )
    }

    async logInAccount(payload: {email: string, password: string}){
        const [exists] = await this.db
            .select()
            .from(userTable)
            .where(
                eq(
                    userTable.email, payload.email
                )
            )
        
        if(!exists){
            throw new Error("404 not found")
        }

        if(!exists.passwordHash){
            throw new Error("Account created with google")
        }

        if(await this.credSerivice.comparePassword(payload.password, exists.passwordHash)){
            throw new Error("Forbidden error")
        }
        
    }
}
