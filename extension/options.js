const KEY = "cleanSlateSettings";
const MODEL_KEY = "cleanSlateModel";
// Every write on this page goes through here. A rejected set() — quota, a
// closing profile — used to surface nowhere: the Save message said "Saved
// locally." and nothing had been saved. Storage is the only thing this product
// has, so a failure has to be visible.
async function write(items,failure){
  try{ await chrome.storage.local.set(items); return true; }
  catch(error){ $("#saved").textContent=failure||"Could not save. Your browser refused the write."; return false; }
}
async function wipe(keys,failure){
  try{ await chrome.storage.local.remove(keys); return true; }
  catch(error){ $("#saved").textContent=failure||"Could not delete. Your browser refused the write."; return false; }
}
const DEFAULTS = {"onboardingComplete":false,"enabled":true,"mode":"discover","thresholdByMode":{"focus":70,"discover":45,"digest":68},"interests":["AI infrastructure","developer tools","startups"],"mutedPhrases":["thrilled to announce","agree?","work anniversary"],"allowedAuthors":[],"blockedAuthors":[],"authorMarks":{},"authorDecayDays":30,"statsResetAt":0,"profiles":[],"activeProfile":null,"structuralFiltering":true,"hideRightRail":true,"hideLeftRailExtras":true,"stats":{"checked":0,"hidden":0,"dimmed":0,"revealed":0,"feedback":0,"reviewGood":0,"reviewBad":0,"learnedAcknowledged":0}};
const { sanitizeSettings, sanitizeModel } = CleanSlateEngine;
let settings;
const $ = (selector) => document.querySelector(selector);
const unique = (items) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
let loadedAt=0;
// What the people lists held when this page loaded. mergeOnSave uses it to tell
// "the feed added this while I was open" from "I removed this here", without
// depending on a decay stamp — the positive feed actions do not
// stamp, so entries added by ★ or "Never miss" were silently dropped on Save.
let loadedLists={allowedAuthors:[],blockedAuthors:[]};
// Names pinned on this page. The pin removes a decay stamp, and mergeOnSave
// takes authorMarks fresh from storage because they belong to the feed — so
// without this the removal was discarded on every Save and the button did
// nothing at all.
const pinnedSinceLoad=new Set();
// This page defers most writes to Save and performs a few immediately, and
// nothing distinguished them. Accepting the profile-delete confirm reads as
// final; closing the tab undid it.
let dirty=false;
function markDirty(){ dirty=true; const el=$("#pending"); if(el)el.hidden=false; }
function markClean(){ dirty=false; const el=$("#pending"); if(el)el.hidden=true; }

async function load(){
  loadedAt=Date.now();
  const saved=(await chrome.storage.local.get(KEY))[KEY]||{};
  settings={...DEFAULTS,...saved,thresholdByMode:{...DEFAULTS.thresholdByMode,...(saved.thresholdByMode||{})}};
  loadedLists={allowedAuthors:[...(settings.allowedAuthors||[])],blockedAuthors:[...(settings.blockedAuthors||[])]};
  pinnedSinceLoad.clear();
  render();
}

// ---- profiles ----
// A profile owns its topics and muted phrases; people, cleanup and the learned
// model are shared. The Default profile is the top-level settings.
function activeProfile(){return (settings.profiles||[]).find((profile)=>profile.id===settings.activeProfile)||null;}
const PROFILE_OWNED=["interests","mutedPhrases"];
function listFor(key){const profile=activeProfile();if(profile&&PROFILE_OWNED.includes(key)){profile[key]=profile[key]||[];return profile[key];}return settings[key];}
function thresholdFor(){const profile=activeProfile();return profile&&typeof profile.threshold==="number"?profile.threshold:settings.thresholdByMode.discover;}
function renderProfiles(){
  const select=$("#profile-select");select.replaceChildren();
  for(const {id,name} of [{id:"",name:"Default"},...(settings.profiles||[]).map((profile)=>({id:profile.id,name:profile.name}))]){
    const option=document.createElement("option");option.value=id;option.textContent=name;select.append(option);
  }
  select.value=settings.activeProfile||"";
  const profile=activeProfile();
  $("#profile-rename").disabled=!profile;
  $("#profile-delete").disabled=!profile;
  $("#threshold-label").textContent=profile?`Discover threshold for “${profile.name}”`:"Discover threshold";
  $("#profile-scope").textContent=`Editing ${profile?`“${profile.name}”`:"the Default profile"}. The topics and muted phrases below belong to it; people, cleanup and learning are shared across every profile.`;
}

const PEOPLE_LISTS=["allowedAuthors","blockedAuthors"];

// A name judged from the feed carries a stamp and fades; one typed here does
// not. Nothing used to show which was which, so entries quietly expired and
// people came back with no explanation.
function decayNote(value){
  const days=Number(settings.authorDecayDays)||0;
  const mark=(settings.authorMarks||{})[value.toLowerCase().replace(/\s+/g," ").trim()];
  if(!mark)return{text:"typed here · never fades",fading:false,pinnable:false};
  if(!days)return{text:"from the feed · fading is off",fading:false,pinnable:false};
  const left=Math.max(0,days-(Date.now()-mark)/86400000);
  return{text:`from the feed · fades in ${Math.ceil(left)} day${Math.ceil(left)===1?"":"s"}`,fading:true,pinnable:true};
}

function chips(key){
  const list=listFor(key);
  const container=$("#"+key);
  container.innerHTML="";
  const people=PEOPLE_LISTS.includes(key);
  list.forEach((value,index)=>{
    const chip=document.createElement("span");
    chip.className="chip";
    const name=document.createElement("span");
    name.textContent=value;
    chip.append(name);

    if(people){
      const note=decayNote(value);
      const meta=document.createElement("span");
      meta.className="chip__meta"+(note.fading?" chip__meta--fading":"");
      meta.textContent=note.text;
      chip.append(meta);
      if(note.pinnable){
        const pin=document.createElement("button");
        pin.type="button";pin.textContent="pin";
        pin.title=`Stop "${value}" from fading`;
        pin.addEventListener("click",()=>{
          const normalised=value.toLowerCase().replace(/\s+/g," ").trim();
          pinnedSinceLoad.add(normalised);
          settings.authorMarks=Object.fromEntries(
            Object.entries(settings.authorMarks||{}).filter(([n])=>n!==normalised));
          chips(key);
          markDirty();
        });
        chip.append(pin);
      }
    }

    const remove=document.createElement("button");
    remove.type="button";remove.textContent="×";
    remove.setAttribute("aria-label",`Remove ${value}`);
    remove.addEventListener("click",()=>{list.splice(index,1);chips(key,`Removed ${value}.`);markDirty();});
    chip.append(remove);
    container.append(chip);
  });
}
const decayLabel=(days)=>Number(days)?`${days} days`:"never";
function render(){renderProfiles();chips("interests");chips("mutedPhrases");chips("allowedAuthors");chips("blockedAuthors");$("#discover-threshold").value=thresholdFor();$("#threshold-value").textContent=thresholdFor();$("#author-decay").value=settings.authorDecayDays;$("#decay-value").textContent=decayLabel(settings.authorDecayDays);$("#structural").checked=settings.structuralFiltering;$("#right-rail").checked=settings.hideRightRail;$("#left-rail").checked=settings.hideLeftRailExtras;}
const inputFor={interests:"#interest-input",mutedPhrases:"#muted-input",allowedAuthors:"#allowed-input",blockedAuthors:"#blocked-input"};
function add(key,input){const list=listFor(key);const next=unique([...list,...$(input).value.split(/[,\n;]/)]);list.length=0;list.push(...next);$(input).value="";chips(key,`${next.length} entr${next.length===1?"y":"ies"} in this list.`);$(input).focus();markDirty();}
// These lists accept a pasted batch and had no way to empty one, so a runaway
// muted-people list could only be escaped by deleting everything.
document.querySelectorAll("[data-clear]").forEach((button)=>button.addEventListener("click",()=>{
  const key=button.dataset.clear;
  const list=listFor(key);
  if(!list.length)return;
  if(!confirm(`Remove all ${list.length} names? Takes effect when you save.`))return;
  list.length=0;
  chips(key,"List cleared.");
  markDirty();
}));
document.querySelectorAll("[data-add]").forEach((button)=>button.addEventListener("click",()=>add(button.dataset.add,inputFor[button.dataset.add])));
Object.entries(inputFor).forEach(([key,selector])=>$(selector).addEventListener("keydown",(event)=>{if(event.key==="Enter"){event.preventDefault();add(key,selector);}}));
$("#settings-form").addEventListener("input",markDirty);
$("#settings-form").addEventListener("change",markDirty);
$("#discover-threshold").addEventListener("input",(event)=>$("#threshold-value").textContent=event.target.value);
$("#author-decay").addEventListener("input",(event)=>$("#decay-value").textContent=decayLabel(event.target.value));
// Profile edits stay in memory until Save, like every control on this page.
$("#profile-select").addEventListener("change",(event)=>{settings.activeProfile=event.target.value||null;render();});
$("#profile-add").addEventListener("click",()=>{const name=$("#profile-name").value.trim();if(!name)return;const id=`p${Date.now().toString(36)}`;settings.profiles=[...(settings.profiles||[]),{id,name,interests:[],mutedPhrases:[],threshold:settings.thresholdByMode.discover}];settings.activeProfile=id;$("#profile-name").value="";render();markDirty();});
$("#profile-rename").addEventListener("click",()=>{const profile=activeProfile();if(!profile)return;const name=($("#profile-name").value||prompt("Rename this profile:",profile.name)||"").trim();if(!name)return;profile.name=name;$("#profile-name").value="";render();markDirty();});
$("#profile-delete").addEventListener("click",()=>{const profile=activeProfile();if(!profile)return;if(!confirm(`Delete “${profile.name}” and its topics and muted phrases? Takes effect when you save.`))return;settings.profiles=settings.profiles.filter((other)=>other.id!==profile.id);settings.activeProfile=null;render();markDirty();});
// This page holds a snapshot taken when it loaded, and the feed keeps writing to
// the same key while it is open. Writing the snapshot back would undo anything
// that happened in between — mute an author, then hit Save here, and the mute is
// gone.
//
// So re-read at save time. Counters and stamps belong to the feed and are taken
// from storage untouched. For the two people lists, entries the feed stamped
// AFTER this page loaded are judgements this page never saw, so they survive; a
// chip removed here is still removed, because its stamp is older.
async function mergeOnSave(){
  const stored=(await chrome.storage.local.get(KEY))[KEY];
  if(!stored)return settings;

  // Marks belong to the feed, except the ones pinned here — a pin IS the removal
  // of a mark, so taking storage wholesale threw it away every time.
  const marks=Object.fromEntries(
    Object.entries(stored.authorMarks||{}).filter(([name])=>!pinnedSinceLoad.has(name)));

  // Anything in storage that this page never saw was added by the feed while it
  // was open, so it survives. Anything this page loaded and then removed stays
  // removed, because it is absent from `settings` but present in loadedLists.
  // Comparing against the load-time snapshot rather than a decay stamp is what
  // makes this work for ★ and "Never miss", which do not stamp.
  const addedSinceLoad=(list)=>(stored[list]||[]).filter((name)=>!loadedLists[list].includes(name));

  return {
    ...settings,
    stats:stored.stats||settings.stats,
    statsResetAt:Math.max(Number(stored.statsResetAt)||0,Number(settings.statsResetAt)||0),
    authorMarks:marks,
    allowedAuthors:unique([...settings.allowedAuthors,...addedSinceLoad("allowedAuthors")]),
    blockedAuthors:unique([...settings.blockedAuthors,...addedSinceLoad("blockedAuthors")])
  };
}

$("#settings-form").addEventListener("submit",async(event)=>{event.preventDefault();settings.onboardingComplete=true;const threshold=Number($("#discover-threshold").value);const editing=activeProfile();if(editing)editing.threshold=threshold;else settings.thresholdByMode={...settings.thresholdByMode,discover:threshold};settings.authorDecayDays=Number($("#author-decay").value);settings.structuralFiltering=$("#structural").checked;settings.hideRightRail=$("#right-rail").checked;settings.hideLeftRailExtras=$("#left-rail").checked;settings=await mergeOnSave();if(!await write({[KEY]:settings}))return;markClean();$("#saved").textContent="Saved locally.";setTimeout(()=>$("#saved").textContent="",2400);});
// Carries the learned model as well as the settings. A restore without it handed
// back a filter that had forgotten everything and contributed nothing until eight
// more judgements — while this button is described, three lines below it on the
// page, as how you move to a new machine.
//
// The hidden-post log is NOT in the file: it holds other people's writing,
// and putting that in a download sits badly against "nothing leaves this
// browser". help.html says so too.
$("#export").addEventListener("click",async()=>{
  const stored=await chrome.storage.local.get([KEY,MODEL_KEY]);
  const payload={
    format:"clean-slate/settings",
    version:chrome.runtime.getManifest().version,
    settings:stored[KEY]||settings,
    model:stored[MODEL_KEY]||null
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");link.href=url;link.download="clean-slate-settings.json";link.click();
  URL.revokeObjectURL(url);
});
// Import is what makes Export worth having: without it an exported file could
// only be reapplied by hand-editing storage. The file is untrusted by the time
// it comes back — hand-edited, from an older version, or not ours — so it goes
// through sanitizeSettings, which rebuilds it from the defaults and copies over
// only known keys of the right type.
$("#import").addEventListener("click",()=>$("#import-file").click());
$("#import-file").addEventListener("change",async(event)=>{
  const file=event.target.files&&event.target.files[0];
  event.target.value="";
  if(!file)return;
  let parsed;
  try{parsed=JSON.parse(await file.text());}
  catch(_){$("#saved").textContent="That file is not valid JSON.";return;}
  // A file written before the model was included is a bare settings object, so
  // both shapes are accepted.
  const body=parsed&&typeof parsed==="object"&&parsed.settings?parsed.settings:parsed;
  const clean=sanitizeSettings(body,Date.now());
  if(!clean){$("#saved").textContent="That file does not look like Clean Slate settings.";return;}
  const model=parsed&&typeof parsed==="object"?sanitizeModel(parsed.model):null;

  if(!confirm(model
    ?"Replace every Clean Slate setting in this browser, and everything the filter has learned, with the contents of this file?"
    :"Replace every Clean Slate setting in this browser with the contents of this file? This file carries no learned model, so the filter starts over."))return;

  const writes={[KEY]:clean};
  if(model)writes[MODEL_KEY]=model;
  if(!await write(writes))return;
  await load();
  await renderLearned();
  $("#saved").textContent=model?"Settings and learning imported.":"Settings imported.";
  setTimeout(()=>$("#saved").textContent="",2400);
});
// Counters could only be cleared by deleting the model and the hidden-post log with
// them. They are just numbers on the popup; resetting them should cost nothing.
$("#reset-counters").addEventListener("click",async()=>{
  if(!confirm("Set every counter back to zero? That includes the review score. Your settings and everything the filter has learned stay as they are."))return;
  const stored=(await chrome.storage.local.get(KEY))[KEY]||settings;
  // statsResetAt is no longer read. A feed tab takes the zeros from the event
  // and adds its next delta to them, so a reset sticks without needing to be
  // told apart from a stale echo. The field stays because it is persisted and
  // validated; removing it is a schema change for no gain.
  const zeroed={...stored,statsResetAt:Date.now(),stats:{...DEFAULTS.stats,learnedAcknowledged:stored.stats?.learnedAcknowledged||0}};
  if(!await write({[KEY]:zeroed}))return;
  await load();
  $("#saved").textContent="Counters reset.";
  setTimeout(()=>$("#saved").textContent="",2400);
});
// Names everything it destroys. The old wording said "preferences and counters"
// while also taking the learned model and the hidden-post log, neither of which can be
// recovered. The two trailing keys hold no user data but were left behind.
$("#reset").addEventListener("click",async()=>{
  if(!confirm("Delete everything: your settings, your counters, what the filter has learned, and the log of hidden posts. You cannot undo this."))return;
  if(!await wipe([KEY,"cleanSlateModel","cleanSlateFoldLog","cleanSlateBreakageSnooze","cleanSlateIconScheme"]))return;
  await load();await renderLearned();$("#saved").textContent="Local data deleted.";
});

// ---- learned model inspector ----
function tokenWeightIn(model,token){return Math.log(((model.pos[token]||0)+0.5)/(model.posDocs+1))-Math.log(((model.neg[token]||0)+0.5)/(model.negDocs+1));}
function learnedChip(container,token,weight,onApprove,onForget){
  const chip=document.createElement("span");chip.className="chip";
  chip.textContent=`${token} ${weight>0?"+":""}${weight.toFixed(1)}`;
  const approve=document.createElement("button");approve.type="button";approve.textContent="+";
  approve.title=weight>0?"Make this a permanent interest":"Make this a permanent muted phrase";
  approve.addEventListener("click",()=>{onApprove();chip.remove();});
  const forget=document.createElement("button");forget.type="button";forget.textContent="×";
  forget.title=`Forget "${token}" without touching anything else it has learned`;
  forget.addEventListener("click",async()=>{await onForget();chip.remove();});
  chip.append(approve,forget);container.append(chip);
}

// Removing one word used to mean wiping the whole model. Deleting the token from
// both bags leaves every other word, and the judgement counts, intact.
async function forgetWord(token){
  const model=(await chrome.storage.local.get(MODEL_KEY))[MODEL_KEY];
  if(!model)return;
  delete model.pos[token];delete model.neg[token];
  if(!await write({[MODEL_KEY]:model}))return;
}
// The one control here that writes without waiting for Save, so it must write
// ONLY that word — writing `settings` would commit every unsaved edit too. An
// unsaved profile has nowhere to land, so the chip waits for Save.
async function promoteWord(key,word){
  const list=listFor(key);
  if(!list.includes(word))list.push(word);
  chips(key);
  const stored=(await chrome.storage.local.get(KEY))[KEY];
  if(!stored)return;
  const target=settings.activeProfile
    ?(stored.profiles||[]).find((profile)=>profile.id===settings.activeProfile)
    :stored;
  if(!target)return;
  target[key]=unique([...(target[key]||[]),word]);
  if(!await write({[KEY]:stored}))return;
}

async function renderLearned(){
  const model={pos:{},neg:{},posDocs:0,negDocs:0,...((await chrome.storage.local.get(MODEL_KEY))[MODEL_KEY]||{})};
  const total=model.posDocs+model.negDocs;
  $("#learned-summary").textContent=total?`Learned from ${total} judgement${total===1?"":"s"} (${model.posDocs} kept, ${model.negDocs} hidden).`:"No feedback yet. Use ★, Hide, Mute, or reveal posts on the feed and check back.";
  // Seeing the inspector is what acknowledged means.
  // Write the one field, not the whole page snapshot. Persisting `settings` here
  // reverted everything the feed had written since this page loaded, and
  // committed unsaved edits the user had not pressed Save on — the same hazard
  // mergeOnSave exists to avoid, one function away from it.
  if(settings&&total!==settings.stats.learnedAcknowledged){
    settings.stats={...settings.stats,learnedAcknowledged:total};
    const stored=(await chrome.storage.local.get(KEY))[KEY];
    if(stored)await write({[KEY]:{...stored,stats:{...stored.stats,learnedAcknowledged:total}}});
  }
  const posEl=$("#learned-pos"),negEl=$("#learned-neg");posEl.innerHTML="";negEl.innerHTML="";
  if(total<8)return;
  const vocab=[...new Set([...Object.keys(model.pos),...Object.keys(model.neg)])]
    .filter((t)=>((model.pos[t]||0)+(model.neg[t]||0))>=2)
    .map((t)=>({t,w:tokenWeightIn(model,t)}))
    .filter((x)=>Math.abs(x.w)>0.35)
    .sort((a,b)=>Math.abs(b.w)-Math.abs(a.w));
  for(const {t,w} of vocab.filter((x)=>x.w>0).slice(0,10))
    learnedChip(posEl,t,w,()=>promoteWord("interests",t),()=>forgetWord(t));
  for(const {t,w} of vocab.filter((x)=>x.w<0).slice(0,10))
    learnedChip(negEl,t,w,()=>promoteWord("mutedPhrases",t),()=>forgetWord(t));
}
// The hidden-post log is not learning, and it is the review page's only source of
// data, so deleting it silently emptied that page. Named in the confirm.
$("#reset-model").addEventListener("click",async()=>{if(!confirm("Forget everything the filter has learned? This clears the log of hidden posts as well, so the review page will be empty."))return;if(!await wipe(["cleanSlateModel","cleanSlateFoldLog"]))return;await renderLearned();});
// renderLearned needs `settings`, so it waits for load() rather than racing it.
load().then(renderLearned);
