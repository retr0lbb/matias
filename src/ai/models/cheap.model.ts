import { GoogleGenAI, Model } from "@google/genai";
import { AiProvider } from "../ai-provider.type.js";

export class CheapModel implements AiProvider{
    private readonly client: GoogleGenAI

    constructor(apiKey: string){
        this.client = new GoogleGenAI({
            apiKey: apiKey,
        })
    }

    async generate(input: { message: string; }): Promise<string> {
        const interaction = await this.client.interactions.create({
            model: "gemini-3.1-flash-lite",
            input: input.message
        })

        console.log(interaction)

        return interaction.output_text ?? ""
    }
}