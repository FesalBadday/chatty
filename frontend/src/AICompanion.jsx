import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const API_BASE =
  (typeof import !== 'undefined' && typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE) ||
  (typeof window !== 'undefined' && window.__API_BASE__) ||
  "";

const POSITIVE_WORDS=["love","great","awesome","good","nice","cool","happy","wonderful","amazing","yay","fun","thanks","thank you","sweet"];
const NEGATIVE_WORDS=["hate","bad","terrible","sad","angry","upset","annoyed","mad","awful","no","boring","meh"];
function sentimentScore(t=""){t=t.toLowerCase();let s=0;POSITIVE_WORDS.forEach(w=>{if(t.includes(w))s+=1});NEGATIVE_WORDS.forEach(w=>{if(t.includes(w))s-=1});return s}
function pickEmotion(text){const s=sentimentScore(text);if(s>=2)return"excited";if(s===1)return"happy";if(s===0)return text.endsWith("?")?"curious":"neutral";if(s===-1)return"concerned";return"sad"}
function accumulateTranscripts(results,startIndex=0){let finalText="",interim="";for(let i=startIndex;i<results.length;i++){const r=results[i];const t=r[0]?.transcript??"";if(r.isFinal)finalText+=t;else interim+=t}return{finalText,interim}}
const getMicLabel=l=>l?"Stop voice":"Start voice"; const getMicTitle=l=>l?"Tap to stop voice":"Tap to start voice";
function Face({mood="neutral",speaking=false,listening=false}){const eye="rounded-full w-4 h-4 bg-slate-100";const mouthBase="h-1 rounded-full bg-slate-100";
  const mouth=useMemo(()=>{switch(mood){case"excited":return<div className={`${mouthBase} w-12 mt-3`} style={{height:10,borderRadius:10}}/>;case"happy":return<div className={`${mouthBase} w-10 mt-3`} style={{height:6,borderRadius:10}}/>;case"curious":return<div className={`${mouthBase} w-3 mt-3`} style={{height:6,borderRadius:10}}/>;case"concerned":return<div className={`${mouthBase} w-8 mt-3`} style={{height:2}}/>;case"sad":return<div className={`${mouthBase} w-10 mt-3`} style={{height:2,transform:"rotate(180deg)"}}/>;default:return<div className={`${mouthBase} w-8 mt-3`}/>}},[mood]);
  return(<motion.div className="relative w-40 h-40 rounded-full bg-gradient-to-br from-slate-800 to-slate-700 flex items-center justify-center shadow-xl select-none" animate={{scale:speaking?1.05:1,boxShadow:listening?"0 0 0 6px rgba(59,130,246,0.25)":"0 10px 25px rgba(0,0,0,0.35)"}} transition={{type:"spring",stiffness:200,damping:14}}>
    <div className="absolute top-10 flex gap-6">
      <motion.div className={eye} animate={{y:speaking?[0,-2,0]:0}} transition={{repeat:speaking?Infinity:0,duration:0.6}}/>
      <motion.div className={eye} animate={{y:speaking?[0,-2,0]:0}} transition={{repeat:speaking?Infinity:0,duration:0.6,delay:0.1}}/>
    </div>
    <div className="absolute top-20">{mouth}</div>
    <AnimatePresence>{listening&&(<motion.div key="listening" className="absolute -bottom-4 text-xs px-2 py-1 rounded-full bg-blue-500/20 text-blue-200" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:8}}>Listening…</motion.div>)}</AnimatePresence>
  </motion.div>)}
export default function AICompanion(){
  const [messages,setMessages]=useState([{role:"assistant",content:"Hi! I’m your AI companion. Tell me your name and what you like—I'll remember."}]);
  const [input,setInput]=useState(""); const [listening,setListening]=useState(false); const [speaking,setSpeaking]=useState(false); const [mood,setMood]=useState("happy");
  const recRef=useRef(null); const endRef=useRef(null);
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"})},[messages.length]);
  useEffect(()=>{const lastUser=[...messages].reverse().find(m=>m.role==="user"); if(lastUser) setMood(pickEmotion(lastUser.content))},[messages]);
  function speak(text){ if(!("speechSynthesis"in window)) return; const u=new SpeechSynthesisUtterance(text); u.onstart=()=>setSpeaking(true); u.onend=()=>setSpeaking(false); window.speechSynthesis.cancel(); window.speechSynthesis.speak(u) }
  async function handleSend(text){const content=text??input; if(!content.trim())return; setInput(""); setMessages(m=>[...m,{role:"user",content}]);
    try{const resp=await fetch(`${API_BASE}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({message:content})}); const data=await resp.json();
      const reply=data.reply??"(No reply)"; setMessages(m=>[...m,{role:"assistant",content:reply}]); speak(reply);
    }catch(e){const fallback="Server is offline. Try again later."; setMessages(m=>[...m,{role:"assistant",content:fallback}]); speak(fallback);}}
  function startListening(){const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR){alert("Speech Recognition not supported in this browser. Try Chrome or Edge desktop.");return}
    if(recRef.current) recRef.current.stop(); const rec=new SR(); rec.lang="en-US"; rec.interimResults=true; rec.continuous=false; let finalText="";
    rec.onresult=e=>{const {finalText:f,interim}=accumulateTranscripts(e.results,e.resultIndex); finalText=f; setInput(finalText||interim)};
    rec.onend=()=>{setListening(false); recRef.current=null; if(finalText.trim()) handleSend(finalText)}; rec.onerror=()=>{setListening(false)};
    recRef=current=rec; setListening(true); rec.start()}
  function stopListening(){recRef.current?.stop()} function toggleListening(){listening?stopListening():startListening()}
  return(<div className="min-h-screen w-full bg-gradient-to-br from-slate-950 to-neutral-900 text-slate-100 flex flex-col items-center p-6">
    <div className="w-full max-w-3xl grid gap-4">
      <div className="flex items-center justify-between"><div><h1 className="text-2xl font-bold">AI Companion</h1><p className="text-sm text-slate-400">Dark theme • remembers over time</p></div><Face mood={mood} speaking={speaking} listening={listening}/></div>
      <div className="rounded-2xl bg-slate-900/70 shadow-md p-4 h-[50vh] overflow-y-auto border border-slate-800">
        {messages.map((m,i)=>(<div key={i} className={`my-2 flex ${m.role==="user"?"justify-end":"justify-start"}`}><div className={`px-3 py-2 rounded-2xl max-w-[80%] ${m.role==="user"?"bg-indigo-600 text-white rounded-br-sm":"bg-slate-800 text-slate-100 rounded-bl-sm"}`}>{m.content}</div></div>))}
        <div ref={endRef}/>
      </div>
      <div className="flex gap-2 items-center">
        <button className={`px-4 py-2 rounded-xl shadow ${listening?"bg-blue-600 text-white":"bg-slate-800 border border-slate-700 text-slate-100"}`} onClick={toggleListening} title={getMicTitle(listening)}>{getMicLabel(listening)}</button>
        <input className="flex-1 px-4 py-2 rounded-xl border border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-400 shadow focus:outline-none" placeholder="Type a message…" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")handleSend()}}/>
        <button className="px-4 py-2 rounded-xl bg-indigo-600 text-white shadow" onClick={()=>handleSend()}>Send</button>
      </div>
    </div>
  </div>)}
