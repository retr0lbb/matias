
export interface AiProvider{
    generate(input: {message: string}): Promise<string>
}