# Atlas · Family Chat — Cloudflare Worker

Backend proxy that hides API keys, enforces family auth, and injects the Charter system prompt.

## Stack
- **Runtime**: Cloudflare Workers (free tier: 100k req/day)
- **LLM** (multi-provider with auto-fallback):
  - **Primary**: GitHub Models — `openai/gpt-4o-mini` (FREE, ~50-150 req/day per model)
  - **Fallback**: Anthropic — `claude-haiku-4-5` (paid, used only on rate limits)
- **Auth**: identity dropdown (6 family names) + shared passphrase

Set `LLM_PROVIDER=auto` (default) to try GitHub first and fall back to Anthropic on 429/5xx.
Set `LLM_PROVIDER=github` or `anthropic` to lock to one.

## One-time setup (≈ 10 min)

### 1. Get a GitHub Personal Access Token (FREE LLM)
- Go to https://github.com/settings/personal-access-tokens
- **"Generate new token" → Fine-grained**
- Name it: `atlas-family-chat`
- Expiration: 90 days (or longer — you can rotate)
- Permissions: under **"Account permissions"** find **"Models"** → set to **Read-only**
- Generate, copy the token (starts with `github_pat_…`)

### 2. (Optional but recommended) Get an Anthropic API key for fallback
- https://console.anthropic.com/ → Settings → API Keys → Create Key
- Add ~$5 of credits as a safety net for rate-limit days
- Copy `sk-ant-…`. Skip this if you want pure-free mode (`LLM_PROVIDER=github`).

### 3. Cloudflare account
- Free at https://dash.cloudflare.com/sign-up — no credit card needed for Workers free tier.

### 4. Install + login Wrangler
```powershell
cd C:\AITest\atlas-family-chat\worker
npm install
npx wrangler login
```
Browser pops up → approve the OAuth.

### 5. Set the Worker secrets
```powershell
npx wrangler secret put GITHUB_TOKEN
# paste your github_pat_… token

npx wrangler secret put FAMILY_PASSPHRASE
# paste a phrase you'll share via WhatsApp, e.g. "amor-de-familia-2026"

# Optional fallback:
npx wrangler secret put ANTHROPIC_API_KEY
# paste your sk-ant-… key
```
All encrypted; rotate by rerunning the same command.

### 6. Test locally
```powershell
# Copy the example and fill in:
Copy-Item .dev.vars.example .dev.vars
notepad .dev.vars   # paste your real values

npm run dev
# Worker now at http://localhost:8787
```

Smoke-test in another terminal:
```powershell
curl http://localhost:8787/healthz
# expected: { ok: true, provider: "auto", github_token_set: true, ... }
```

### 7. Deploy
```powershell
npm run deploy
```
You'll get a URL like `https://atlas-family-chat.<your-subdomain>.workers.dev`.

### 8. Wire it into the frontend
In `C:\AITest\atlas-family-chat\js\app.js`:
```js
const ATLAS_API = 'https://atlas-family-chat.<your-subdomain>.workers.dev';
```

## Endpoints

- `GET /healthz` — `{ ok, provider, model, *_set }`
- `POST /api/verify` — `{ passphrase }` → 200 `{ ok }` or 401
- `POST /api/chat` — `{ messages, user, passphrase, private? }` → `{ reply, model, provider, usage }`
  - `user`: one of `Daniel | Kattia | Yeyo | Vivi | Sofi | Gabo`

## Tail logs
```powershell
npm run tail
```

## Cost projection
- **GitHub Models** (primary): **$0** unless we exceed ~150 req/day for gpt-4o-mini
- **Anthropic** (fallback): kicks in only on rate-limits → realistically <$1/month even on heavy days
- **Cloudflare**: $0 (free tier covers 100k req/day, we'll see <500)
- **Total expected**: $0-$2/month, vs. ~$20/month ChatGPT subscription you'd cancel

## Switching to pure Anthropic later
If GitHub free tier becomes too tight, set the secret:
```powershell
npx wrangler secret put LLM_PROVIDER
# enter: anthropic
```
Done. No code change.
