
export interface AiProvider{
    loadMemory(data: unknown): Promise<void>
    generate(input: {message: string}): Promise<AIResponse>
}

export type AIResponse = {
  messageId: string,
  status: string,
  usage: {
    total_tokens: number,
    total_input_tokens: number,
  },
  created: string,
  updated: string,
  model: string,
  output_text: string
}