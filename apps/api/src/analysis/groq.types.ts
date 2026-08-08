// ---------------------------------------------------------------------------
// Groq API — minimal OpenAI-compatible chat-completions shapes we consume.
// Endpoint: POST {baseUrl}/openai/v1/chat/completions
// Docs: https://console.groq.com/docs/api-reference
// ---------------------------------------------------------------------------

export interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqChatRequest {
  model: string;
  messages: GroqChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /** JSON mode — the model is constrained to emit a single JSON object. */
  response_format?: { type: 'json_object' };
}

export interface GroqChatChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

export interface GroqChatResponse {
  id: string;
  choices: GroqChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface GroqErrorResponse {
  error?: { message?: string; type?: string; code?: string };
}

export interface RawSkillGapResponse {
  match_score: number;
  seniority_guess: 'entry' | 'mid' | 'senior' | 'unknown';
  matched_skills: string[];
  missing_skills: string[];
  required_skills: Array<{ name: string; required: boolean }>;
  summary_text: string;
}
