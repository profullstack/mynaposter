/** The Claude backend for the writer. */
import Anthropic from "@anthropic-ai/sdk";

export interface CompletionRequest {
  system: string;
  prompt: string;
  model: string;
  maxTokens?: number;
}

/**
 * One completion, returned as text.
 *
 * Adaptive thinking is on because drafting for several networks at once is a
 * small planning problem, not a lookup.
 */
export async function complete({ system, prompt, model, maxTokens = 4000 }: CompletionRequest): Promise<string> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to write this: ${response.stop_details?.explanation ?? "no reason given"}`);
  }

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
