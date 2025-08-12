'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

const app = express();
const prisma = new PrismaClient();

// --------- LLM CONFIG (OpenAI-compatible; defaults to OpenRouter free) ---------
const BASE = process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api';
const MODEL = process.env.OPENAI_MODEL || 'meta-llama/llama-3-8b-instruct:free';
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'nomic-ai/nomic-embed-text-v1.5';
const API_KEY = process.env.OPENAI_API_KEY || '';

console.log('[LLM CONFIG]', {
  BASE,
  MODEL,
  EMBED_MODEL,
  hasKey: !!API_KEY
});

// --------- MIDDLEWARE ---------
app.use(express.json());
app.use(cookieParser());

// CORS: if you’re using Netlify proxy to /api, this is rarely used;
// still keep it configurable for direct cross-origin use.
const allowOrigins = (process.env.ALLOW_ORIGIN || '').split(',').filter(Boolean);
app.use(
  cors({
    origin: allowOrigins.length ? allowOrigins : '*',
    credentials: true,
  })
);

app.use(
  rateLimit({
    windowMs: +(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: +(process.env.RATE_LIMIT_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Anonymous session cookie (for per-user memory). If you’re calling API
// cross-site (no Netlify proxy), you likely need SameSite=None; Secure=true.
const isProd = process.env.NODE_ENV === 'production';
const sameSite = process.env.COOKIE_SAMESITE || (allowOrigins.length ? 'none' : 'lax'); // 'none' for cross-site
const secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd;

app.use((req, res, next) => {
  const cookieName = 'aid';
  let aid = req.cookies?.[cookieName];
  if (!aid) {
    aid = randomUUID();
    res.cookie(cookieName, aid, {
      httpOnly: true,
      sameSite,
      secure,
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
    });
  }
  req.aid = aid;
  next();
});

// --------- LLM HELPERS ---------
async function llmChat(system, user) {
  if (!API_KEY) return '(LLM not configured on server)';

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + API_KEY,
  };

  // OpenRouter etiquette headers
  if ((BASE || '').includes('openrouter.ai')) {
    headers['HTTP-Referer'] = process.env.PUBLIC_URL || 'https://example.com';
    headers['X-Title'] = 'AI Companion';
  }

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false, // IMPORTANT: easier parsing + avoids NDJSON handling
  };

  const resp = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('[CHAT ERROR]', resp.status, text);
    throw new Error('Chat API failed: ' + resp.status);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    console.error('[CHAT UNEXPECTED PAYLOAD]', JSON.stringify(data).slice(0, 1000));
    return '(upstream returned no content)';
  }
  return content;
}

async function llmEmbed(texts) {
  if (!API_KEY) return texts.map(() => []);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + API_KEY,
  };

  if ((BASE || '').includes('openrouter.ai')) {
    headers['HTTP-Referer'] = process.env.PUBLIC_URL || 'https://example.com';
    headers['X-Title'] = 'AI Companion';
  }

  const resp = await fetch(BASE + '/embeddings', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('[EMBED ERROR]', resp.status, text);
    return texts.map(() => []);
  }

  const data = await resp.json();
  return data?.data?.map((d) => d.embedding) ?? texts.map(() => []);
}

function cosine(a, b) {
  const da = Math.hypot(...a), db = Math.hypot(...b);
  if (!da || !db) return 0;
  let dot = 0, len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot / (da * db);
}

// very simple heuristic fact extractor
function naiveExtractFacts(text) {
  const facts = [];
  const mName = text.match(/my name is\s+([A-Za-z\-\s]{2,40})/i);
  if (mName) facts.push(`User name is ${mName[1].trim()}`);

  const mLike = text.match(/i (really )?(like|love)\s+([^.!?]+)/i);
  if (mLike) facts.push(`User likes ${mLike[3].trim()}`);

  const mDis = text.match(/i (really )?dislike\s+([^.!?]+)/i);
  if (mDis) facts.push(`User dislikes ${mDis[2].trim()}`);

  return facts;
}

async function buildSystemPrompt(prisma, aid) {
  const user = await prisma.user.upsert({ where: { aid }, update: {}, create: { aid } });
  const mems = await prisma.memory.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const facts = mems.filter((m) => m.kind === 'fact').slice(0, 50).map((m) => m.text);
  const summaries = mems.filter((m) => m.kind === 'summary').slice(0, 10).map((m) => m.text);

  return [
    'You are a warm, concise, emotionally intelligent AI companion. Match tone. Ask short follow-ups occasionally.',
    facts.length ? 'Known user facts: ' + facts.join(' | ') : '',
    summaries.length ? 'Session summaries: ' + summaries.join(' | ') : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function maybeSummarizeSession(prisma, chatId, userId) {
  // Summarize every ~6 exchanges (12 messages)
  const count = await prisma.message.count({ where: { chatId } });
  if (count % 12 !== 0) return;

  const lastMsgs = await prisma.message.findMany({
    where: { chatId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const convo = lastMsgs.reverse().map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const system =
    'Summarize this conversation into 1-2 concise sentences, focusing on stable preferences/facts. Avoid PII beyond what is present.';

  try {
    const summary = await llmChat(system, convo);
    const [emb] = await llmEmbed([summary]);
    await prisma.memory.create({
      data: { userId, text: summary, embedding: emb, kind: 'summary' },
    });
    console.log('[SESSION SUMMARY SAVED]');
  } catch (e) {
    console.error('[SESSION SUMMARY ERROR]', e?.stack || e);
  }
}

// --------- ROUTES ---------
app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>AI Companion API</h1>
    <p>Service is running.</p>
    <ul>
      <li>Health: <a href="/healthz">/healthz</a></li>
      <li>POST Chat: <code>/api/chat</code></li>
      <li>GET Memory: <a href="/api/me/memory">/api/me/memory</a></li>
    </ul>
  `);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const api = express.Router();

api.post('/chat', async (req, res) => {
  try {
    const aid = req.aid;
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message required' });
    }

    const user = await prisma.user.upsert({ where: { aid }, update: {}, create: { aid } });
    const chat = await prisma.chat.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });

    await prisma.message.create({ data: { chatId: chat.id, role: 'user', content: message } });

    // extract & save simple facts
    const facts = naiveExtractFacts(message);
    if (facts.length) {
      const embeds = await llmEmbed(facts);
      for (let i = 0; i < facts.length; i++) {
        await prisma.memory.create({
          data: { userId: user.id, text: facts[i], embedding: embeds[i], kind: 'fact' },
        });
      }
    }

    // recall
    const all = await prisma.memory.findMany({ where: { userId: user.id }, take: 500 });
    let recall = [];
    if (all.length) {
      const [qVec] = await llmEmbed([message]);
      const scored = all
        .map((m) => ({ m, s: cosine(qVec, m.embedding || []) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 8);
      recall = scored.filter((r) => r.s > 0.1).map((r) => r.m.text);
    }

    const system = (await buildSystemPrompt(prisma, aid)) + (recall.length ? '\nRelevant memories: ' + recall.join(' | ') : '');
    const reply = await llmChat(system, message);

    await prisma.message.create({ data: { chatId: chat.id, role: 'assistant', content: reply } });

    // fire-and-forget
    maybeSummarizeSession(prisma, chat.id, user.id).catch((e) =>
      console.error('[ASYNC SUMMARY ERROR]', e?.stack || e)
    );

    return res.json({ reply });
  } catch (e) {
    console.error('[SERVER_ERROR]', e?.stack || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

api.get('/me/memory', async (req, res) => {
  const aid = req.aid;
  const user = await prisma.user.upsert({ where: { aid }, update: {}, create: { aid } });
  const mems = await prisma.memory.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ items: mems });
});

app.use('/api', api);

// --------- START ---------
const port = +(process.env.PORT || 3000);
app.listen(port, () => console.log('Server listening on ' + port));
