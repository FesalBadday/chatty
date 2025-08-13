import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

// Use Netlify proxy (same-origin): /api → Render
const API_BASE = "";

const POS=["great","awesome","nice","cool","happy","wonderful","amazing","thanks","sweet"];
const NEG=["bad","sad","angry","upset","annoyed","awful","boring","meh"];
const score=t=>{t=(t||"").toLowerCase();let s=0;POS.forEach(w=>t.includes(w)&&s++);NEG.forEach(w=>t.includes(w)&&s--);return s};
const moodOf=t=>score(t)>=1?"happy":(score(t)<=-1?"concerned":(t?.trim().endsWith("?")?"curious":"neutral"));

function Face({ mood="neutral", speaking=false, listening=false }){
  const eye="rounded-full w-4 h-4 bg-slate-100";
  const mouth = useMemo(()=>{
    switch(mood){
      case "happy": return <div className="h-1 w-10 mt-3 rounded-full bg-slate-100" style={{height:6,borderRadius:10}}/>;
      case "curious": return <div className="h-1 w-3 mt-3 rounded-full bg-slate-100" style={{height:6,borderRadius:10}}/>;
      case "concerned": return <div className="h-1 w-8 mt-3 rounded-full bg-slate-100"/>;
      default: return <div className="h-1 w-8 mt-3 rounded-full bg-slate-100"/>;
    }
  },[mood]);
  return (
    <motion.div className="relative w-40 h-40 rounded-full bg-gradient-to-br from-slate-800 to-slate-700 flex items-center justify-center shadow-xl select-none"
      animate={{ scale: speaking?1.05:1, boxShadow: listening? "0 0 0 6px rgba(59,130,246,0.25)" : "0 10px 25px rgba(0,0,0,0.35)" }}
      transition={{ type: "spring", stiffness: 200, damping: 14 }}>
      <div className="absolute top-10 flex gap-6">
        <motion.div className={eye} animate={{y:speaking?[0,-2,0]:0}} transition={{repeat:speaking?Infinity:0,duration:0.6}}/>
        <motion.div className={eye} animate={{y:speaking?[0,-2,0]:0}} transition={{repeat:speaking?Infinity:0,duration:0.6,delay:0.1}}/>
      </div>
      <div className="absolute top-20">{mouth}</div>
      <AnimatePresence>{listening && (<motion.div key="listening" className="absolute -bottom-4 text-xs px-2 py-1 rounded-full bg-blue-500/20 text-blue-200" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:8}}>Listening…</motion.div>)}</AnimatePresence>
    </motion.div>
  );
}

export default function Chat(){
  const [messages,setMessages]=useState([{role:"assistant",content:"Hi! I’m Chattyp — talk to me 👋"}]);
  const [input,setInput]=useState(""); const [speaking,setSpeaking]=useState(false); const [listening,setListening]=useState(false);
  const [mood,setMood]=useState("happy"); const endRef=useRef(null); const recRef=useRef(null);

  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"})},[messages.length]);
  useEffect(()=>{const last=[...messages].reverse().find(m=>m.role==="user"); if(last) setMood(moodOf(last.content))},[messages]);

  function speak(text){ if(!("speechSynthesis" in window)) return; const u=new SpeechSynthesisUtterance(text); u.onstart=()=>setSpeaking(true); u.onend=()=>setSpeaking(false); window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); }

  async function send(text){
    const content=text??input; if(!content.trim()) return; setInput(""); setMessages(m=>[...m,{role:"user",content}]);
    try{
      const r=await fetch(`${API_BASE}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({message:content})});
      const data=await r.json();
      const reply=data.reply ?? (data.error ? `(error: ${data.error})` : "(No reply)");
      setMessages(m=>[...m,{role:"assistant",content:reply}]); speak(reply);
    }catch(e){ const msg="Server is offline. Try again later."; setMessages(m=>[...m,{role:"assistant",content:msg}]); speak(msg); }
  }

  function startListening(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if(!SR){ alert("Speech Recognition not supported. Try Chrome/Edge."); return; }
    if(recRef.current) recRef.current.stop(); const rec=new SR(); rec.lang="en-US"; rec.interimResults=true; rec.continuous=false; let finalText="";
    rec.onresult=(e)=>{ for(let i=e.resultIndex;i<e.results.length;i++){ const t=e.results[i][0]?.transcript||""; if(e.results[i].isFinal) finalText+=t; else setInput((finalText||t)); } };
    rec.onend=()=>{ setListening(false); recRef.current=null; if(finalText.trim()) send(finalText); };
    rec.onerror=()=> setListening(false);
    recRef.current=rec; setListening(true); rec.start();
  }
  function stopListening(){ recRef.current?.stop(); } function toggleListening(){ listening?stopListening():startListening(); }

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 to-neutral-900 text-slate-100 flex flex-col items-center p-6">
      <div className="w-full max-w-3xl grid gap-4">
        <div className="flex items-center justify-between"><div><h1 className="text-2xl font-bold">Chattyp</h1><p className="text-sm text-slate-400">Dark, chatty, and remembers</p></div><Face mood={mood} speaking={speaking} listening={listening}/></div>
        <div className="rounded-2xl bg-slate-900/70 shadow-md p-4 h-[50vh] overflow-y-auto border border-slate-800">
          {messages.map((m,i)=>(<div key={i} className={`my-2 flex ${m.role==="user"?"justify-end":"justify-start"}`}>
            <div className={`px-3 py-2 rounded-2xl max-w-[80%] ${m.role==="user"?"bg-indigo-600 text-white rounded-br-sm":"bg-slate-800 text-slate-100 rounded-bl-sm"}`}>{m.content}</div>
          </div>))}
          <div ref={endRef}/>
        </div>
        <div className="flex gap-2 items-center">
          <button className={`px-4 py-2 rounded-xl shadow ${listening?"bg-blue-600 text-white":"bg-slate-800 border border-slate-700 text-slate-100"}`} onClick={toggleListening}>
            {listening?"Stop voice":"Start voice"}
          </button>
          <input className="flex-1 px-4 py-2 rounded-xl border border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-400 shadow focus:outline-none"
            placeholder="Type a message…" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter") send()}}/>
          <button className="px-4 py-2 rounded-xl bg-indigo-600 text-white shadow" onClick={()=>send()}>Send</button>
        </div>
      </div>
    </div>
  );
}
