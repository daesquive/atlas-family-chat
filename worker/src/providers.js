// Atlas · Family Chat — LLM provider adapters
// Two providers, same shape. Worker picks one (or fails over) per request.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const GITHUB_MODELS_API = 'https://models.github.ai/inference/chat/completions';

// Model IDs per provider.
export const MODELS = {
  github:    'openai/gpt-4o-mini',   // free tier on GitHub Models
  anthropic: 'claude-haiku-4-5',     // paid fallback ($1/M in, $5/M out)
};

const MAX_TOKENS = 1024;

/**
 * Call Anthropic Claude.
 * @returns {{ ok: boolean, status: number, reply?: string, model?: string, usage?: any, error?: string, retryable?: boolean }}
 */
export async function callAnthropic({ system, messages, apiKey }) {
  if (!apiKey) return { ok: false, status: 500, error: 'Missing ANTHROPIC_API_KEY', retryable: false };

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELS.anthropic,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      error: `Anthropic ${res.status}: ${errText.slice(0, 200)}`,
      retryable: res.status === 429 || res.status >= 500,
    };
  }

  const data = await res.json();
  const reply = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  return { ok: true, status: 200, reply, model: data.model, usage: data.usage };
}

/**
 * Call GitHub Models (OpenAI-compatible endpoint).
 * Auth: GitHub PAT with `models:read` scope.
 * Supports OpenAI tool-calling when `tools` is provided.
 */
export async function callGitHubModels({ system, messages, token, tools }) {
  if (!token) return { ok: false, status: 500, error: 'Missing GITHUB_TOKEN', retryable: false };

  // messages may already include `tool` role + tool_calls during a tool loop —
  // pass through unchanged so OpenAI gets the full conversation.
  const oaiMessages = [
    { role: 'system', content: system },
    ...messages,
  ];

  const body = {
    model: MODELS.github,
    messages: oaiMessages,
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(GITHUB_MODELS_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      error: `GitHub Models ${res.status}: ${errText.slice(0, 200)}`,
      // 429 = rate-limited (free tier exhausted) → fall back to Anthropic.
      // 5xx = transient → also fall back.
      retryable: res.status === 429 || res.status >= 500,
    };
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const msg = (choice && choice.message) || {};
  const reply = (msg.content || '').trim();
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;

  return {
    ok: true,
    status: 200,
    reply,
    tool_calls: toolCalls,
    raw_message: msg,
    model: data.model,
    usage: data.usage,
    finish_reason: choice && choice.finish_reason,
  };
}

/**
 * High-level: try primary provider, fall back to secondary on retryable failures.
 * Provider order is read from env.LLM_PROVIDER:
 *   - 'github'    → GitHub Models only (no fallback)
 *   - 'anthropic' → Anthropic only (no fallback)
 *   - 'auto'      → GitHub first, Anthropic fallback (default; recommended)
 */
export async function callLLM({ system, messages, env, tools }) {
  const mode = env.LLM_PROVIDER || 'auto';

  // NOTE: Anthropic adapter doesn't currently implement tool-calling.
  // If the chat is currently mid-tool-loop and we fall back, tools are dropped
  // and the model just answers from its own knowledge. Acceptable for MVP.
  if (mode === 'anthropic') {
    return await callAnthropic({ system, messages: stripToolMessages(messages), apiKey: env.ANTHROPIC_API_KEY });
  }

  if (mode === 'github') {
    return await callGitHubModels({ system, messages, token: env.GITHUB_TOKEN, tools });
  }

  // auto: prefer GitHub Models (free), fall back to Anthropic on rate-limit / outage.
  const primary = await callGitHubModels({ system, messages, token: env.GITHUB_TOKEN, tools });
  if (primary.ok) return { ...primary, provider: 'github' };

  if (primary.retryable && env.ANTHROPIC_API_KEY) {
    console.log('GitHub Models failed, falling back to Anthropic:', primary.error);
    const fallback = await callAnthropic({ system, messages: stripToolMessages(messages), apiKey: env.ANTHROPIC_API_KEY });
    if (fallback.ok) return { ...fallback, provider: 'anthropic-fallback' };
    return fallback;
  }

  return primary;
}

// Anthropic doesn't accept role:'tool' or assistant tool_calls — strip them
// so a fallback mid-tool-loop still produces a valid reply.
function stripToolMessages(messages) {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
    .filter(m => m.content.length > 0);
}
