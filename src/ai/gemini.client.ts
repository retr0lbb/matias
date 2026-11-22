import { GoogleGenAI } from "@google/genai";
import { Injectable, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

const REQUEST_TIMEOUT_MS = 90_000;

/** The one Gemini client of the app: chat models, the judge and document generation share it. */
@Injectable()
export class GeminiClient {
	readonly genai: GoogleGenAI;

	constructor(configService: ConfigService) {
		this.genai = new GoogleGenAI({
			apiKey: configService.getOrThrow<string>("GEMINI_API_KEY"),
			httpOptions: { timeout: REQUEST_TIMEOUT_MS },
		});
	}
}

/** Standalone so AiModule and DocumentsModule can both import it without a cycle. */
@Module({
	imports: [ConfigModule],
	providers: [GeminiClient],
	exports: [GeminiClient],
})
export class GeminiModule {}
