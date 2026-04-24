/**
 * src/tier2/claude/callClaude.ts
 *
 * Thin wrapper around the Anthropic Messages API.
 * Uses native `fetch` (Node ≥ 18) — no SDK dependency.
 *
 * Expects the response content to be a JSON object matching GeneratedEmail.
 * The LLM is instructed by buildPrompt to emit raw JSON; this module
 * extracts and parses it.
 */

import type { GeneratedEmail } from "../types/index.js";

export interface ClaudeCallOptions {
  apiKey: string;
  model?: string;        // default: "claude-haiku-4-5"
  maxTokens?: number;    // default: 1024
  temperature?: number;  // default: 0.7
}

interface AnthropicMessage {
  role: "user";
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  messages: AnthropicMessage[];
}

interface AnthropicContentBlock {
  type: "text";
  text: string;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Extract the first JSON object from a string.
 * The LLM may surround the JSON with markdown fences or whitespace.
 */
function extractJson(text: string): string {
  // Strip ```json ... ``` or ``` ... ``` fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Fallback: find first { ... } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }

  return text.trim();
}

/**
 * Call Claude and return a parsed GeneratedEmail.
 *
 * @throws if the API returns a non-2xx status or the response JSON cannot be parsed.
 */
export async function callClaude(
  systemPrompt: string,
  userPrompt: string,
  options: ClaudeCallOptions
): Promise<GeneratedEmail> {
  const model = options.model ?? "claude-haiku-4-5";
  const maxTokens = options.maxTokens ?? 1024;
  const temperature = options.temperature ?? 0.7;

  const body: AnthropicRequest = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Anthropic API error ${response.status}: ${errorText}`
    );
  }

  const data = (await response.json()) as AnthropicResponse;

  const rawText = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!rawText) {
    throw new Error("Claude returned an empty response.");
  }

  const jsonStr = extractJson(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Failed to parse Claude response as JSON.\nRaw output:\n${rawText}`
    );
  }

  // Basic shape validation — full validation is done by validateEmail()
  const email = parsed as GeneratedEmail;
  if (!email.subject || !email.body) {
    throw new Error(
      `Claude response missing required fields (subject, body).\nParsed: ${JSON.stringify(parsed)}`
    );
  }

  return email;
}
