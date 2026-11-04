import { GoogleGenAI, Model } from "@google/genai";
import { AiProvider, AIResponse } from "../ai-provider.type.js";

export class CheapModel implements AiProvider{
    private readonly client: GoogleGenAI

    constructor(apiKey: string){
        this.client = new GoogleGenAI({
            apiKey: apiKey,
        })
    }

    async generate(input: { message: string; }): Promise<AIResponse> {
        const interaction = await this.client.interactions.create({
            model: "gemini-3.1-flash-lite",
            input: input.message
        })

        return {
            messageId: interaction.id,
            model: interaction.model ?? "gemini-3.1-flash-lite",
            status: interaction.status,
            created: interaction.created ?? "",
            output_text: interaction.output_text ?? "",
            updated: interaction.updated ?? "",
            usage: {
                total_input_tokens: interaction.usage?.total_input_tokens ?? 0,
                total_tokens: interaction.usage?.total_tokens ?? 0
            }
        }
    }


    loadMemory(data: unknown): Promise<void> {
        //bota memoria no modelo
    }
}