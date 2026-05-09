// Atlas · Family Chat — tool definitions and executors
// Currently: web_search via Tavily (1000 free searches/mo, AI-friendly).

const TAVILY_API = 'https://api.tavily.com/search';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Busca información actualizada en la web cuando la familia te pregunte sobre noticias recientes, eventos actuales, hechos verificables, clima, resultados deportivos, precios, o cualquier dato que pueda haber cambiado después de tu fecha de entrenamiento. NO la uses para saludos, conversaciones emocionales, opiniones, ni preguntas sobre la propia familia. Si la usas, cita las fuentes naturalmente al final de tu respuesta (ej: "Fuente: BBC, ESPN").',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Consulta de búsqueda específica y concisa. Puede ir en español o inglés según qué idioma dé mejores resultados para el tema.',
          },
        },
        required: ['query'],
      },
    },
  },
];

export async function executeTool(name, args, env) {
  if (name === 'web_search') {
    return await tavilySearch(args && args.query, env);
  }
  return { error: `Unknown tool: ${name}` };
}

async function tavilySearch(query, env) {
  if (!query || typeof query !== 'string') {
    return { error: 'Empty query' };
  }
  if (!env.TAVILY_API_KEY) {
    return { error: 'Search unavailable: no Tavily API key configured.' };
  }

  try {
    const res = await fetch(TAVILY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: query.slice(0, 400),
        search_depth: 'basic',
        max_results: 5,
        include_answer: true,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { error: `Tavily ${res.status}: ${txt.slice(0, 200)}` };
    }

    const data = await res.json();
    return {
      query,
      summary: data.answer || '',
      results: (data.results || []).slice(0, 5).map(r => ({
        title: r.title,
        url: r.url,
        snippet: String(r.content || '').slice(0, 400),
      })),
    };
  } catch (e) {
    return { error: `Search failed: ${e.message || String(e)}` };
  }
}
