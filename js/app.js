// Atlas · Family Chat — frontend shell
// Phase 2: real backend wired. Falls back to mock if ATLAS_API is unset.

(() => {
  'use strict';

  // ============ CONFIG ============
  // Set this to your deployed Worker URL after `wrangler deploy`.
  // Empty string = use mock replies (Phase 1 mode).
  // For local Worker dev: 'http://localhost:8787'
  const ATLAS_API = 'https://atlas-family-chat.esquivel.workers.dev';

  const $ = sel => document.querySelector(sel);

  const welcome = $('#welcome');
  const chat = $('#chat');
  const startBtn = $('#start-btn');
  const backBtn = $('#back-btn');
  const noRemember = $('#no-remember');
  const sessionMode = $('#session-mode');
  const atlasGreet = $('#atlas-greet');
  const messages = $('#messages');
  const composer = $('#composer');
  const input = $('#input');
  const sendBtn = $('#send-btn');
  const whoAmI = $('#who-am-i');
  const passphrase = $('#passphrase');
  const authError = $('#auth-error');
  const micBtn = $('#mic-btn');
  const speakToggle = $('#speak-toggle');

  let session = {
    private: false,
    history: [],
    user: '',
    passphrase: '',
  };

  // Restore last user choice (not the passphrase — that's typed each time).
  const lastUser = localStorage.getItem('afc.user');
  if (lastUser) whoAmI.value = lastUser;

  function showAuthError(msg) {
    authError.textContent = msg;
    authError.hidden = false;
  }
  function clearAuthError() {
    authError.hidden = true;
    authError.textContent = '';
  }

  // ==================== Screen transitions ====================
  function showScreen(which) {
    welcome.classList.toggle('active', which === 'welcome');
    chat.classList.toggle('active', which === 'chat');
  }

  startBtn.addEventListener('click', async () => {
    clearAuthError();

    const who = whoAmI.value;
    const phrase = passphrase.value.trim();
    if (!who) { showAuthError('Por favor elige tu nombre.'); return; }
    if (!phrase) { showAuthError('Por favor escribe la frase de la familia.'); return; }

    startBtn.disabled = true;
    startBtn.textContent = 'Verificando…';

    // Verify passphrase against the Worker before letting them in.
    if (ATLAS_API) {
      try {
        const verify = await fetch(`${ATLAS_API}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: phrase }),
        });
        if (!verify.ok) {
          showAuthError('Frase incorrecta. Pídesela a Daniel.');
          startBtn.disabled = false;
          startBtn.textContent = 'Empezar a conversar →';
          return;
        }
      } catch (err) {
        showAuthError('No pude verificar ahora mismo. Revisa tu conexión.');
        startBtn.disabled = false;
        startBtn.textContent = 'Empezar a conversar →';
        return;
      }
    }
    // (If ATLAS_API is empty we're in mock mode — accept any non-empty passphrase.)

    session.private = noRemember.checked;
    session.history = [];
    session.user = who;
    session.passphrase = phrase;
    localStorage.setItem('afc.user', who);

    sessionMode.textContent = session.private ? `${who} · modo privado` : `${who} · en línea`;
    atlasGreet.textContent = `Atlas · para ${who}`;
    messages.innerHTML = '';
    passphrase.value = '';
    startBtn.disabled = false;
    startBtn.textContent = 'Empezar a conversar →';

    showScreen('chat');

    if (session.private) {
      addMessage('system', 'Esta sesión es privada. No se guardará en la memoria de Daniel ni en la mía.');
    }

    // Personalized opening based on who's logged in.
    setTimeout(() => {
      const opener = openingFor(who, session.private);
      addMessage('atlas', opener);
      session.history.push({ role: 'assistant', content: opener });
    }, 400);
  });

  function openingFor(who, isPrivate) {
    const base = {
      Daniel:  '¡Hola, hermano! ¿Cómo va todo? 💙',
      Kattia:  '¡Hola, Kattia! Qué alegría que vinieras. ¿Cómo te sientes hoy?',
      Yeyo:    '¡Yeyo! Me alegra verte por aquí. ¿Cómo va todo en Amazon y en la vida?',
      Vivi:    '¡Hola, Vivi! Qué bonito que pases a saludar. ¿Cómo estás?',
      Sofi:    '¡Hola, Sofi! ¿Cómo va todo? Cuéntame de ti — del trabajo, la uni, lo que quieras.',
      Gabo:    '¡Gabo! Qué chiva que pasaste. ¿Cómo va el código y los estudios?',
    }[who] || `¡Hola, ${who}! Me alegra conocerte por aquí. ¿Cómo te sientes hoy?`;

    return isPrivate
      ? `${base}\n\n(Esta charla es solo entre tú y yo — Daniel no la verá.)`
      : base;
  }

  backBtn.addEventListener('click', () => {
    if (session.history.length > 0) {
      const ok = confirm('¿Seguro que quieres volver al inicio? Se perderá esta conversación si no se ha guardado.');
      if (!ok) return;
    }
    session = { private: false, history: [], user: '', passphrase: '' };
    showScreen('welcome');
    noRemember.checked = false;
    clearAuthError();
  });

  // ==================== Composer ====================
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  input.addEventListener('input', autoResize);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addMessage('me', text);
    session.history.push({ role: 'user', content: text });
    input.value = '';
    autoResize();
    sendBtn.disabled = true;

    try {
      const reply = await callAtlas(text);
      addMessage('atlas', reply);
      session.history.push({ role: 'assistant', content: reply });
    } catch (err) {
      addMessage('system', 'Hubo un problema al contactar a Atlas. Intenta de nuevo en un momento.');
      console.error(err);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  });

  // ==================== Atlas backend ====================
  async function callAtlas(userText) {
    if (!ATLAS_API) {
      // No backend configured — fall back to mock (Phase 1 behavior).
      await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
      const mockReplies = [
        'Te escucho. Cuéntame más, no hay prisa.',
        'Eso suena importante. ¿Qué crees que está detrás de ese sentimiento?',
        'Gracias por compartirlo conmigo. ¿Hay algo en concreto en lo que pueda ayudarte?',
        'Estoy aquí. Sigue, te acompaño en esto.',
        '(Modo demo — configura ATLAS_API en js/app.js para conectar al Worker real).',
      ];
      return mockReplies[Math.floor(Math.random() * mockReplies.length)];
    }

    // Real call to Cloudflare Worker.
    const payload = {
      messages: session.history.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
      user: session.user,
      passphrase: session.passphrase,
      private: session.private,
    };

    const res = await fetch(`${ATLAS_API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Atlas API ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    return data.reply || '(Atlas no devolvió texto. Intenta de nuevo.)';
  }

  // ==================== UI helpers ====================
  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    if (role === 'atlas' && voice.speakEnabled) {
      voice.speak(text);
    }
  }

  // ==================== Voice (Web Speech API) ====================
  const voice = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const synth = window.speechSynthesis || null;
    const supportsSTT = !!SR;
    const supportsTTS = !!synth;
    const LANG = 'es-MX';

    let recognition = null;
    let listening = false;
    let speakEnabled = localStorage.getItem('afc.speak') === '1';

    if (supportsSTT) {
      recognition = new SR();
      recognition.lang = LANG;
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      let interim = '';
      let baseText = '';

      recognition.addEventListener('start', () => {
        listening = true;
        baseText = input.value.trim();
        interim = '';
        micBtn.classList.add('listening');
        micBtn.setAttribute('aria-pressed', 'true');
        micBtn.title = 'Escuchando… toca para detener';
      });

      recognition.addEventListener('result', (ev) => {
        let finalText = '';
        interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        const composed = [baseText, (finalText || interim).trim()].filter(Boolean).join(' ');
        input.value = composed;
        autoResize();
        if (finalText) baseText = composed;
      });

      recognition.addEventListener('error', (ev) => {
        console.warn('SpeechRecognition error:', ev.error);
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          addMessage('system', 'No pude acceder al micrófono. Revisa los permisos del navegador.');
        }
      });

      recognition.addEventListener('end', () => {
        listening = false;
        micBtn.classList.remove('listening');
        micBtn.setAttribute('aria-pressed', 'false');
        micBtn.title = 'Mantén presionado o toca para hablar';
        input.focus();
      });
    }

    function start() {
      if (!supportsSTT) {
        addMessage('system', 'Tu navegador no soporta entrada por voz. Usa Chrome o Edge en desktop.');
        return;
      }
      if (listening) return;
      try { recognition.start(); } catch (e) { /* already running */ }
    }
    function stop() {
      if (listening) recognition.stop();
    }
    function toggle() {
      if (listening) stop(); else start();
    }

    function pickVoice() {
      if (!supportsTTS) return null;
      const voices = synth.getVoices();
      if (!voices || voices.length === 0) return null;
      const prefs = ['es-MX', 'es-US', 'es-419', 'es-ES', 'es'];
      for (const tag of prefs) {
        const v = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(tag.toLowerCase()));
        if (v) return v;
      }
      return voices[0] || null;
    }

    function speak(text) {
      if (!supportsTTS || !text) return;
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = LANG;
      const v = pickVoice();
      if (v) utter.voice = v;
      utter.rate = 1.0;
      utter.pitch = 1.0;
      synth.speak(utter);
    }

    function setSpeakEnabled(on) {
      speakEnabled = !!on;
      localStorage.setItem('afc.speak', speakEnabled ? '1' : '0');
      speakToggle.textContent = speakEnabled ? '🔊' : '🔈';
      speakToggle.setAttribute('aria-pressed', speakEnabled ? 'true' : 'false');
      speakToggle.title = speakEnabled ? 'Lectura en voz alta: ON (toca para apagar)' : 'Lectura en voz alta: OFF (toca para encender)';
      speakToggle.classList.toggle('on', speakEnabled);
      if (!speakEnabled && supportsTTS) synth.cancel();
    }

    return {
      get supportsSTT() { return supportsSTT; },
      get supportsTTS() { return supportsTTS; },
      get listening() { return listening; },
      get speakEnabled() { return speakEnabled; },
      start, stop, toggle, speak, setSpeakEnabled,
    };
  })();

  // Mic button: tap to toggle dictation
  if (voice.supportsSTT) {
    micBtn.addEventListener('click', () => voice.toggle());
  } else {
    micBtn.disabled = true;
    micBtn.title = 'Voz no soportada en este navegador (usa Chrome/Edge)';
    micBtn.style.opacity = '0.4';
  }

  // Speak toggle in header
  if (voice.supportsTTS) {
    voice.setSpeakEnabled(voice.speakEnabled); // initialize button state from localStorage
    speakToggle.addEventListener('click', () => voice.setSpeakEnabled(!voice.speakEnabled));
    // Voices load asynchronously in some browsers
    if (window.speechSynthesis) {
      window.speechSynthesis.addEventListener?.('voiceschanged', () => {});
    }
  } else {
    speakToggle.disabled = true;
    speakToggle.title = 'Lectura en voz alta no soportada en este navegador';
    speakToggle.style.opacity = '0.4';
  }

  // Stop dictation when sending
  composer.addEventListener('submit', () => { if (voice.listening) voice.stop(); });
})();
