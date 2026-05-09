// Atlas Family Chat — Phase 4 memory layer
// D1 persistence + tiered-TTL extractor + recall.

const TTL_MS = {
  long_term: 365 * 24 * 60 * 60 * 1000,
  seasonal:   90 * 24 * 60 * 60 * 1000,
  ephemeral:  14 * 24 * 60 * 60 * 1000,
};
const TIERS = new Set(['evergreen', 'long_term', 'seasonal', 'ephemeral']);

function now() { return Date.now(); }

function expiresAtFor(tier) {
  if (tier === 'evergreen') return null;
  const ms = TTL_MS[tier];
  if (ms == null) return null;
  return now() + ms;
}

// Quick null-DB guard so the worker still functions during migration / outage.
function hasDB(env) { return !!env.DB; }

/**
 * Persist one chat message. Skips writes when private=true.
 * Returns the inserted row id, or null on skip / failure.
 */
export async function writeMessage(env, { user, role, content, isPrivate }) {
  if (!hasDB(env) || isPrivate) return null;
  if (!content || !content.trim()) return null;
  try {
    const result = await env.DB.prepare(
      'INSERT INTO messages (user, role, content, is_private, created_at) VALUES (?, ?, ?, 0, ?)'
    ).bind(user, role, content.slice(0, 8000), now()).run();
    return result.meta && result.meta.last_row_id;
  } catch (err) {
    console.error('writeMessage failed', err);
    return null;
  }
}

/**
 * Pull active (non-expired, non-superseded) memories for a user.
 * Evergreen first, then most recent. Capped at `limit`.
 */
export async function recallMemories(env, user, limit = 25) {
  if (!hasDB(env)) return [];
  try {
    const t = now();
    const { results } = await env.DB.prepare(
      `SELECT id, fact, tier, created_at FROM memories
        WHERE user = ?
          AND superseded_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY (CASE WHEN expires_at IS NULL THEN 0 ELSE 1 END), created_at DESC
        LIMIT ?`
    ).bind(user, t, limit).all();
    return results || [];
  } catch (err) {
    console.error('recallMemories failed', err);
    return [];
  }
}

/**
 * Render memories as a system-prompt fragment in Spanish.
 * Returns '' when no memories exist.
 */
export function renderRecallSection(user, memories) {
  if (!memories || memories.length === 0) return '';
  const lines = memories.map(m => {
    const marker = m.tier === 'evergreen' ? '🟢' : m.tier === 'long_term' ? '🔵' : m.tier === 'seasonal' ? '🟡' : '🔴';
    return `  ${marker} ${m.fact}`;
  }).join('\n');
  return `\n\n## LO QUE RECUERDAS DE ${user.toUpperCase()}\n${lines}\n\nUsa esto con naturalidad — no recites la lista, solo deja que informe tus respuestas.`;
}

/**
 * Ask the LLM to extract durable facts from a single user message.
 * Returns an array of {fact, tier, contradicts_id?}. Empty array on any failure.
 *
 * Runs as fire-and-forget via ctx.waitUntil — must not block the chat response.
 */
export async function extractFacts(env, { user, message, callLLMFn }) {
  if (!message || message.length < 4) return [];

  const sys = `Eres un extractor de hechos durables. Lee UN mensaje de un miembro de la familia llamado "${user}" y extrae solo hechos persistentes sobre esa persona — cosas que valga la pena recordar para futuras conversaciones.

NIVELES disponibles:
- evergreen: identidad permanente (nombres, parentesco, alergias, condiciones crónicas, profesión-como-identidad, mascotas, cumpleaños).
- long_term: estado vigente que probablemente dure ~1 año (trabajo actual, escuela, ciudad, hobbies, proyectos en curso).
- seasonal: planes o eventos a meses (viajes próximos, exámenes, temporada deportiva, metas a corto plazo).
- ephemeral: estado de ánimo del día, qué comió, charla pasajera (~2 semanas).

REGLAS ESTRICTAS:
1. Si el mensaje no contiene NADA durable (saludo, pregunta general, charla trivial), responde con: []
2. NUNCA inventes información que no esté explícita en el mensaje.
3. Cada hecho debe ser una frase corta y declarativa en español, en tercera persona.
4. Si un hecho nuevo contradice un patrón típico (ej. cambio de trabajo, mudanza), márcalo añadiendo "_supersede": true.
5. Devuelve SOLO un array JSON válido, sin texto antes ni después.

EJEMPLOS:
Mensaje: "Hola Atlas, ¿cómo estás?" → []
Mensaje: "Mañana tengo examen de mate" → [{"fact":"Tiene examen de matemáticas mañana","tier":"ephemeral"}]
Mensaje: "Empecé un trabajo nuevo en Microsoft" → [{"fact":"Trabaja en Microsoft","tier":"long_term","_supersede":true}]
Mensaje: "Mi perro Tini cumple 5 años hoy" → [{"fact":"Tini (su perro) cumple años hoy","tier":"ephemeral"},{"fact":"Tiene un perro llamado Tini","tier":"evergreen"}]`;

  try {
    const result = await callLLMFn({
      system: sys,
      messages: [{ role: 'user', content: message.slice(0, 4000) }],
      env,
      tools: undefined,
    });
    if (!result.ok) return [];
    let raw = (result.reply || '').trim();
    // Strip markdown fences if model wrapped them
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    if (!raw.startsWith('[')) {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) raw = m[0]; else return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(f => f && typeof f.fact === 'string' && TIERS.has(f.tier))
      .map(f => ({ fact: f.fact.slice(0, 500), tier: f.tier, supersede: !!f._supersede }))
      .slice(0, 8);
  } catch (err) {
    console.error('extractFacts failed', err);
    return [];
  }
}

/**
 * Store extracted facts. If supersede=true, mark recent matching memories
 * (same user, same tier) as superseded.
 */
export async function storeFacts(env, { user, facts, sourceMessageId }) {
  if (!hasDB(env) || !facts || facts.length === 0) return 0;
  let inserted = 0;
  const t = now();
  for (const f of facts) {
    try {
      if (f.supersede) {
        // Naive contradiction handling: expire any active memory in same tier
        // for this user. Phase 4.1 can refine to semantic match.
        await env.DB.prepare(
          `UPDATE memories SET superseded_at = ?
            WHERE user = ? AND tier = ? AND superseded_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)`
        ).bind(t, user, f.tier, t).run();
      }
      const exp = expiresAtFor(f.tier);
      await env.DB.prepare(
        `INSERT INTO memories (user, fact, tier, source_message_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(user, f.fact, f.tier, sourceMessageId || null, exp, t).run();
      inserted++;
    } catch (err) {
      console.error('storeFacts insert failed', err, f);
    }
  }
  return inserted;
}

/**
 * Nightly cron: hard-delete expired and superseded rows.
 */
export async function sweepExpired(env) {
  if (!hasDB(env)) return { messages_deleted: 0, memories_deleted: 0 };
  const t = now();
  const memCutoff = t - 7 * 24 * 60 * 60 * 1000; // keep superseded 7d for audit
  try {
    const m = await env.DB.prepare(
      `DELETE FROM memories
        WHERE (expires_at IS NOT NULL AND expires_at < ?)
           OR (superseded_at IS NOT NULL AND superseded_at < ?)`
    ).bind(t, memCutoff).run();
    // Optional: trim very old messages (keep 90d of raw messages)
    const msgCutoff = t - 90 * 24 * 60 * 60 * 1000;
    const msgRes = await env.DB.prepare(
      'DELETE FROM messages WHERE created_at < ?'
    ).bind(msgCutoff).run();
    return {
      memories_deleted: (m.meta && m.meta.changes) || 0,
      messages_deleted: (msgRes.meta && msgRes.meta.changes) || 0,
    };
  } catch (err) {
    console.error('sweepExpired failed', err);
    return { error: String(err) };
  }
}

/**
 * Daniel-only admin: list recent messages for a given user.
 */
export async function adminListMessages(env, { user, limit = 100 }) {
  if (!hasDB(env)) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, user, role, content, created_at FROM messages
        WHERE user = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(user, Math.min(limit, 500)).all();
    return results || [];
  } catch (err) {
    console.error('adminListMessages failed', err);
    return [];
  }
}

/**
 * Daniel-only admin: list active memories for a given user.
 */
export async function adminListMemories(env, { user }) {
  if (!hasDB(env)) return [];
  try {
    const t = now();
    const { results } = await env.DB.prepare(
      `SELECT id, fact, tier, expires_at, created_at FROM memories
        WHERE user = ? AND superseded_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY (CASE WHEN expires_at IS NULL THEN 0 ELSE 1 END), created_at DESC`
    ).bind(user, t).all();
    return results || [];
  } catch (err) {
    console.error('adminListMemories failed', err);
    return [];
  }
}

/**
 * Daniel-only admin: forget one fact by id.
 */
export async function adminForgetFact(env, { factId }) {
  if (!hasDB(env)) return { ok: false };
  try {
    const r = await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(factId).run();
    return { ok: true, deleted: (r.meta && r.meta.changes) || 0 };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
