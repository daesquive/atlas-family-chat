// Atlas · Family Chat — Cloudflare Worker
// Phase 3.5: identity + passphrase + multi-provider LLM (GitHub Models free, Anthropic fallback).

import { SYSTEM_PROMPT } from './system-prompt.js';
import { callLLM, MODELS } from './providers.js';
import { TOOLS, executeTool } from './tools.js';

const FAMILY_ROSTER = new Set(['Daniel', 'Kattia', 'Yeyo', 'Vivi', 'Sofi', 'Gabo']);

const ALLOWED_ORIGINS = new Set([
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'https://daesquive.github.io',
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'http://localhost:8000';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkPassphrase(provided, env) {
  if (!env.FAMILY_PASSPHRASE) return false;
  return safeEqual(String(provided || ''), env.FAMILY_PASSPHRASE);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      const provider = env.LLM_PROVIDER || 'auto';
      return jsonResponse({
        ok: true,
        provider,
        model: provider === 'anthropic' ? MODELS.anthropic : MODELS.github,
        github_token_set: !!env.GITHUB_TOKEN,
        anthropic_key_set: !!env.ANTHROPIC_API_KEY,
        passphrase_set: !!env.FAMILY_PASSPHRASE,
        web_search_enabled: !!env.TAVILY_API_KEY,
      }, 200, origin);
    }

    // ----- /api/verify : passphrase check (used by login screen) -----
    if (url.pathname === '/api/verify' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400, origin); }
      if (!checkPassphrase(body && body.passphrase, env)) {
        return jsonResponse({ error: 'Frase incorrecta' }, 401, origin);
      }
      return jsonResponse({ ok: true }, 200, origin);
    }

    // ----- /api/chat : main LLM proxy -----
    if (url.pathname !== '/api/chat' || request.method !== 'POST') {
      return jsonResponse({ error: 'Not found' }, 404, origin);
    }

    if (!env.FAMILY_PASSPHRASE) {
      return jsonResponse({ error: 'Server not configured (missing passphrase)' }, 500, origin);
    }
    if (!env.GITHUB_TOKEN && !env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'Server not configured (no LLM provider)' }, 500, origin);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400, origin); }

    const { messages, user, passphrase, private: isPrivate } = body || {};

    if (!checkPassphrase(passphrase, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401, origin);
    }
    if (typeof user !== 'string' || !FAMILY_ROSTER.has(user)) {
      return jsonResponse({ error: 'Unknown family member' }, 403, origin);
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonResponse({ error: 'messages array required' }, 400, origin);
    }

    const cleaned = messages.slice(-20).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 4000),
    })).filter(m => m.content.length > 0);

    if (cleaned.length === 0) {
      return jsonResponse({ error: 'No usable messages' }, 400, origin);
    }

    const userHint = `\n\nLa persona con quien estás hablando se identifica como: **${user}**. Trátala con la calidez y el conocimiento que tengas de ella en la sección "LA FAMILIA QUE CONOCES".`;
    const privacyHint = isPrivate
      ? '\n\nNOTA DE PRIVACIDAD: Esta sesión es privada. Daniel NO verá esta conversación. Respeta esa confidencialidad.'
      : '';

    const system = SYSTEM_PROMPT + userHint + privacyHint;

    // ---- Tool-calling loop ----
    // The model can request web_search. We execute it server-side, feed results
    // back, and loop up to MAX_ROUNDS. Tools are only offered if Tavily key is set.
    const toolsEnabled = !!env.TAVILY_API_KEY;
    const offeredTools = toolsEnabled ? TOOLS : undefined;
    const MAX_ROUNDS = 3;

    let convo = [...cleaned];
    let lastResult = null;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await callLLM({ system, messages: convo, env, tools: offeredTools });
      lastResult = result;

      if (!result.ok) {
        console.error('LLM error', result);
        return jsonResponse({ error: 'Upstream error', detail: result.error }, 502, origin);
      }

      const toolCalls = result.tool_calls;
      if (!toolCalls || toolCalls.length === 0) break;

      // Append the assistant message that requested tools, then each tool result.
      convo.push(result.raw_message);
      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function && tc.function.arguments || '{}'); } catch {}
        const toolResult = await executeTool(tc.function && tc.function.name, args, env);
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult).slice(0, 6000),
        });
      }
      // loop again so the model can read the results and reply
    }

    return jsonResponse({
      reply: (lastResult && lastResult.reply) || '(Atlas no devolvió texto. Intenta de nuevo.)',
      model: lastResult && lastResult.model,
      provider: lastResult && lastResult.provider,
      usage: lastResult && lastResult.usage,
    }, 200, origin);
  },
};
