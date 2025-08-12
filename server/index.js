\
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

const BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
console.log('[LLM CONFIG]', { BASE, MODEL, EMBED_MODEL, hasKey: !!process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: (process.env.ALLOW_ORIGIN || '*').split(','), credentials: true }));
app.use(rateLimit({ windowMs: +(process.env.RATE_LIMIT_WINDOW_MS||60000), max: +(process.env.RATE_LIMIT_MAX||60) }));

app.use((req, res, next) => {
  const cookieName = 'aid';
  let aid = req.cookies?.[cookieName];
  if (!aid) {
    aid = randomUUID();
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(cookieName, aid, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000*60*60*24*365 });
  }
  req.aid = aid;
  next();
});

async function llmChat(system, user) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return "(LLM not configured on server)";
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  if ((BASE||'').includes('openrouter.ai')) { headers['HTTP-Referer']=process.env.PUBLIC_URL||'https://example.com'; headers['X-Title']='AI Companion'; }
  const resp = await fetch(BASE + '/chat/completions', {
    method: 'POST', headers,
    body: JSON.stringify({ model: MODEL, messages: [{role:'system',content:system},{role:'user',content:user}], stream:false })
  });
  if (!resp.ok) { const t = await resp.text(); console.error('[CHAT ERROR]', resp.status, t); throw new Error('Chat API failed: '+resp.status); }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  return content ?? '(upstream returned no content)';
}

async function llmEmbed(texts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return texts.map(()=>[]);
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  if ((BASE||'').includes('openrouter.ai')) { headers['HTTP-Referer']=process.env.PUBLIC_URL||'https://example.com'; headers['X-Title']='AI Companion'; }
  const resp = await fetch(BASE + '/embeddings', { method:'POST', headers, body: JSON.stringify({ model: EMBED_MODEL, input: texts }) });
  if (!resp.ok) { const t = await resp.text(); console.error('[EMBED ERROR]', resp.status, t); return texts.map(()=>[]); }
  const data = await resp.json(); return data?.data?.map(d=>d.embedding) ?? texts.map(()=>[]);
}

function cosine(a,b){ const da=Math.hypot(...a), db=Math.hypot(...b); if(!da||!db) return 0; let dot=0,len=Math.min(a.length,b.length); for(let i=0;i<len;i++) dot+=a[i]*b[i]; return dot/(da*db) }
function naiveExtractFacts(text){
  const facts=[];
  const mName=text.match(/my name is\s+([A-Za-z\-\s]{2,40})/i); if(mName) facts.push(`User name is ${mName[1].trim()}`);
  const mLike=text.match(/i (really )?(like|love)\s+([^.!?]+)/i); if(mLike) facts.push(`User likes ${mLike[3].trim()}`);
  const mDis =text.match(/i (really )?dislike\s+([^.!?]+)/i);     if(mDis)  facts.push(`User dislikes ${mDis[2].trim()}`);
  return facts;
}
async function buildSystemPrompt(prisma, aid){
  const user = await prisma.user.upsert({ where:{ aid }, update:{}, create:{ aid } });
  const mems = await prisma.memory.findMany({ where:{ userId: user.id }, orderBy:{ createdAt:'desc' }, take: 200 });
  const facts = mems.filter(m=>m.kind==='fact').slice(0,50).map(m=>m.text);
  const summaries = mems.filter(m=>m.kind==='summary').slice(0,10).map(m=>m.text);
  return [
    'You are a warm, concise, emotionally intelligent AI companion. Match tone. Ask short follow-ups occasionally.',
    facts.length ? 'Known user facts: '+facts.join(' | ') : '',
    summaries.length ? 'Session summaries: '+summaries.join(' | ') : ''
  ].filter(Boolean).join('\\n');
}
async function maybeSummarizeSession(prisma, chatId, userId){
  const count = await prisma.message.count({ where:{ chatId } });
  if (count % 12 !== 0) return;
  const lastMsgs = await prisma.message.findMany({ where:{ chatId }, orderBy:{ createdAt:'desc' }, take: 20 });
  const ordered = lastMsgs.reverse();
  const convo = ordered.map(m=>`${m.role.toUpperCase()}: ${m.content}`).join('\\n');
  const system = 'Summarize this conversation into 1-2 sentences, focusing on stable user preferences/facts.';
  try{
    const summary = await llmChat(system, convo);
    const [emb] = await llmEmbed([summary]);
    await prisma.memory.create({ data:{ userId, text: summary, embedding: emb, kind: 'summary' } });
    console.log('[SESSION SUMMARY SAVED]');
  }catch(e){ console.error('[SESSION SUMMARY ERROR]', e); }
}

const appRouter = express.Router();
appRouter.post('/chat', async (req,res)=>{
  try{
    const aid = req.aid; const { message } = req.body || {};
    if(!message || typeof message!=='string') return res.status(400).json({ error:'message required' });

    const user = await prisma.user.upsert({ where:{ aid }, update:{}, create:{ aid } });
    const chat = await prisma.chat.upsert({ where:{ userId: user.id }, update:{}, create:{ userId: user.id } });
    await prisma.message.create({ data:{ chatId: chat.id, role:'user', content: message } });

    const facts = naiveExtractFacts(message);
    if(facts.length){
      const embeds = await llmEmbed(facts);
      for(let i=0;i<facts.length;i++){
        await prisma.memory.create({ data:{ userId: user.id, text: facts[i], embedding: embeds[i], kind:'fact' } });
      }
    }

    const all = await prisma.memory.findMany({ where:{ userId: user.id }, take: 500 });
    let recall=[];
    if(all.length && message){
      const [qVec] = await llmEmbed([message]);
      const scored = all.map(m=>({ m, s: cosine(qVec, m.embedding||[]) })).sort((a,b)=>b.s-a.s).slice(0,8);
      recall = scored.filter(r=>r.s>0.1).map(r=>r.m.text);
    }

    const system = (await buildSystemPrompt(prisma, aid)) + (recall.length? ('\\nRelevant memories: '+recall.join(' | ')) : '');
    const reply = await llmChat(system, message);

    await prisma.message.create({ data:{ chatId: chat.id, role:'assistant', content: reply } });
    maybeSummarizeSession(prisma, chat.id, user.id);

    res.json({ reply });
  }catch(e){ console.error(e); res.status(500).json({ error:'server_error' }); }
});
appRouter.get('/me/memory', async (req,res)=>{
  const aid=req.aid; const user=await prisma.user.upsert({ where:{ aid }, update:{}, create:{ aid } });
  const mems=await prisma.memory.findMany({ where:{ userId: user.id }, orderBy:{ createdAt:'desc' }, take:200 });
  res.json({ items: mems });
});
app.use('/api', appRouter);
app.get('/healthz', (_req,res)=>res.json({ ok:true }));

const port = +(process.env.PORT||3000);
app.listen(port, ()=>console.log('Server listening on '+port));
