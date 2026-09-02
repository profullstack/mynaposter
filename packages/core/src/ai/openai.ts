/**
 * The OpenAI and Ollama backends.
 *
 * Both speak the chat-completions shape, so one function covers them; Ollama
 * just points at localhost and needs no key.
 */
import { postJson } from "../util/http.ts";

interface ChatResponse {
  choices: { message: { content: string } }[];
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  model: string;
  maxTokens?: number;
}

export async function completeOpenAI({ system, prompt, model, maxTokens = 4000 }: CompletionRequest): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");

  const response = await postJson<ChatResponse>(
    "https://api.openai.com/v1/chat/completions",
    {
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    { headers: { authorization: `Bearer ${key}` }, timeoutMs: 120_000 },
  );
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function completeOllama({ system, prompt, model }: CompletionRequest): Promise<string> {
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const response = await postJson<{ message: { content: string } }>(
    `${host}/api/chat`,
    {
      model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    { timeoutMs: 300_000 },
  );
  return response.message?.content?.trim() ?? "";
}

/**
 * Generate an image and return the raw bytes.
 * Used by the infographic's `openai` backend.
 */
export async function generateImage(prompt: string, size = "1024x1024", model = "gpt-image-2"): Promise<Uint8Array> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");

  const response = await postJson<{ data: { b64_json?: string; url?: string }[] }>(
    "https://api.openai.com/v1/images/generations",
    { model, prompt, size, n: 1 },
    { headers: { authorization: `Bearer ${key}` }, timeoutMs: 180_000 },
  );

  const image = response.data?.[0];
  if (image?.b64_json) return new Uint8Array(Buffer.from(image.b64_json, "base64"));
  if (image?.url) {
    const fetched = await fetch(image.url);
    return new Uint8Array(await fetched.arrayBuffer());
  }
  throw new Error("The image API returned no image.");
}
