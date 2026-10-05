import { GoogleGenAI } from "@google/genai";
import { AiProvider } from "../ai-provider.type.js";

export class ExpensiveModel implements AiProvider{
    private readonly client: GoogleGenAI

    constructor(apiKey: string){
        this.client = new GoogleGenAI({
            apiKey: apiKey,
        })
    }

    async generate(input: { message: string; }): Promise<string> {
        const interaction = await this.client.interactions.create({
            model: "gemini-3.8-flash",
            input: input.message
        })

        return interaction.output_text ?? ""
    }
}