import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { CredentialService } from '../shared/services/credentials.js';
import { User, userTable } from '../db/schemas/user.js';
import { eq } from 'drizzle-orm';

@Injectable()
export class AuthService {
    constructor(
        @InjectDrizzle() private readonly db: NodePgDatabase,
        private readonly credSerivice: CredentialService
    ){}

    private normalize = (email: string) => email.trim().normalize('NFC').toLowerCase();

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
            throw new ConflictException("Email already exists")
        }

        const hashedPass = await this.credSerivice.hashPassword(payload.password)

        const [user] = await this.db
            .insert(userTable)
            .values(
                {
                    email: this.normalize(payload.email),
                    name: payload.name,
                    emailVerified: false,
                    loginProvider: "LOCAL",
                    passwordHash: hashedPass
                }
            ).returning()

        return user
    }

    async logInAccount(payload: {email: string, password: string}){
        const [user] = await this.db
            .select()
            .from(userTable)
            .where(
                eq(
                    userTable.email, this.normalize(payload.email)
                )
            )
        
        if(!user){
            throw new NotFoundException("User not found")
        }

        if(!user.passwordHash){
            throw new BadRequestException("Account created with google")
        }

        if(!(await this.credSerivice.comparePassword(payload.password, user.passwordHash))){
            throw new UnauthorizedException("Invalid credentials")
        }

        return user

    }

    async findByGoogleSubject(subject: string): Promise<User | null>{
        const [user] = await this.db.select().from(userTable).where(eq(userTable.googleSubject, subject))
        return user ?? null
    }

    async findByEmail(email: string): Promise<User | null>{
        const normalizedEmail = email.trim().normalize("NFC").toLowerCase();
        const [user] = await this.db.select().from(userTable).where(eq(userTable.email, normalizedEmail))
        
        return user ?? null
    }

    async createGoogleUser(payload: {name: string, email: string, subject: string}){
        const [user] = await this.db
        .insert(userTable)
        .values({
            name: payload.name,
            email: payload.email.trim().normalize("NFC").toLowerCase(),
            emailVerified: true,
            loginProvider: "GOOGLE",
            googleSubject: payload.subject,
            passwordHash: null,
        }).returning();

        return user;
    }
}
