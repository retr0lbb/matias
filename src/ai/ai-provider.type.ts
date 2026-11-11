export interface AiProvider {
	generate(input: { message: string }): Promise<AIResponse>;
	generateStream(input: {
		message: string;
		signal?: AbortSignal;
	}): AsyncGenerator<AIStreamChunk>;
}

export type AIResponse = {
	messageId: string;
	status: string;
	usage: {
		total_tokens: number;
		total_input_tokens: number;
	};
	created: string;
	updated: string;
	model: string;
	output_text: string;
	thinking_output?: string;
};

export type AIStreamChunk =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "done"; response: AIResponse };
