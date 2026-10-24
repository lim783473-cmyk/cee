// cee 瘦客户端：算法与 TypeSafe Key 都在网关（cee-api），这里只做
// 捕获管理、表单校验，并把 {text, context} 转发给网关换回 rows。
// secured 用可选调用（?.()）：老内核浏览器（如 360）没有 setAccessLevel
// 时跳过即可，不能让第一行就崩掉整个 service worker。
const secured=Promise.all([chrome.storage.local?.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}),chrome.storage.session?.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'})]);
const MAX_FIELDS=40;
const validField=f=>{
 if(!f||!['title','description','text','email','tel','url','select','combobox'].includes(f.kind)||!/^f(?:[0-9]|[1-3][0-9])$/.test(f.id)||typeof f.label!=='string'||f.label.length>160)return false;
 if(f.kind==='combobox'&&(f.tag!=='input'||f.role!=='combobox'||!['list','both'].includes(f.ariaAutocomplete)||typeof f.ariaControls!=='string'||!f.ariaControls.trim()||typeof f.hasCommittedInput!=='boolean'||!Array.isArray(f.options)))return false;
 if(f.options!==undefined){
  if(!Array.isArray(f.options)||f.options.length>80)return false;
  for(const o of f.options){
   if(!o||typeof o.text!=='string'||o.text.length>160||typeof o.disabled!=='boolean')return false;
   if(o.selected!==undefined&&typeof o.selected!=='boolean')return false;
   if(f.kind==='select'&&(typeof o.value!=='string'||o.value.length>256))return false;
   if(f.kind==='combobox'&&['value','id','elementId'].some(k=>Object.hasOwn(o,k)))return false;
  }
 }
 if(f.tag!==undefined&&!['input','textarea','select','div'].includes(f.tag))return false;
 if(f.elementId!==undefined&&(typeof f.elementId!=='string'||f.elementId.length>120))return false;
 for(const k of ['maxLength','minLength','rows'])if(f[k]!==undefined&&(!Number.isInteger(f[k])||f[k]<0||f[k]>10000))return false;
 for(const k of ['autocomplete','name','role','ariaAutocomplete','ariaControls'])if(f[k]!==undefined&&(typeof f[k]!=='string'||f[k].length>(k==='name'?120:160)))return false;
 return true;
};
const trusted=url=>(url||'').startsWith(chrome.runtime.getURL(''));
const allowed=(url,origin)=>trusted(url)||/^https?:\/\//.test(url||'')||(/^(about|data|blob|filesystem):/.test(url||'')&&/^https?:\/\//.test(origin||''));
const jobKey=s=>`${s.tab?.id??s.url}:${s.frameId??0}:${s.documentId??''}`;
const pending=new Map();
const frameRegistry=new Map();
const latestDocuments=new Map();
const frameKey=(tabId,frameId,documentId)=>`${tabId}:${frameId}:${documentId||''}`;
const documentSlot=(tabId,frameId)=>`${tabId}:${frameId}`;
const originOf=(url,origin)=>{
 try{return new URL(url).origin;}
 catch{return /^https?:\/\//.test(origin||'')?origin:'opaque';}
};
function cancelFrame(tabId,frameId,documentId){
 const prefix=frameKey(tabId,frameId,documentId);
 for(const [key,ctrl] of pending){if(key===prefix||key.startsWith(prefix+':')){ctrl.abort();pending.delete(key);}}
}
function cancelFrameId(tabId,frameId){
 const prefix=documentSlot(tabId,frameId)+':';
 for(const [key,ctrl] of pending){if(key.startsWith(prefix)){ctrl.abort();pending.delete(key);}}
}
async function notifyTop(tabId){try{await chrome.tabs.sendMessage(tabId,{type:'frameRegistryChanged'},{frameId:0});}catch{}}
function registrySummary(tabId){
 const frames=[...frameRegistry.values()].filter(frame=>frame.tabId===tabId).sort((a,b)=>a.depth-b.depth||a.frameId-b.frameId);
 const active=[...frames].filter(frame=>frame.focused&&frame.visible).sort((a,b)=>b.lastSeen-a.lastSeen)[0]||null;
 return {frames,active:active?{frameId:active.frameId,origin:active.origin,heading:active.heading||'',fieldCount:active.fieldCount}:null};
}
async function refreshRegistry(tabId){
 if(!chrome.webNavigation?.getAllFrames)return;
 let frames;try{frames=await chrome.webNavigation.getAllFrames({tabId});}catch{return;}
 if(!Array.isArray(frames))return;
 const actual=new Map(frames.map(frame=>[frame.frameId,frame]));
 for(const current of [...frameRegistry.values()]){
  if(current.tabId!==tabId)continue;
  const latest=actual.get(current.frameId);
  if(!latest||latest.documentId&&current.documentId&&latest.documentId!==current.documentId){
   frameRegistry.delete(frameKey(current.tabId,current.frameId,current.documentId));
   latestDocuments.delete(documentSlot(current.tabId,current.frameId));
   cancelFrame(current.tabId,current.frameId,current.documentId);
  }
 }
 const depthOf=frame=>{let depth=0,parent=frame.parentFrameId,guard=0;while(parent>=0&&guard++<16){const ancestor=actual.get(parent);if(!ancestor)break;depth++;parent=ancestor.parentFrameId;}return depth;};
 for(const frame of frames){
  const documentId=frame.documentId||'';if(!documentId)continue;
  const slot=documentSlot(tabId,frame.frameId),known=latestDocuments.get(slot);
  if(known&&known!==documentId){frameRegistry.delete(frameKey(tabId,frame.frameId,known));cancelFrame(tabId,frame.frameId,known);}
  latestDocuments.set(slot,documentId);
  const key=frameKey(tabId,frame.frameId,documentId),prior=frameRegistry.get(key);
  frameRegistry.set(key,{tabId,frameId:frame.frameId,documentId,parentFrameId:frame.parentFrameId,depth:depthOf(frame),url:String(frame.url||'').slice(0,2048),origin:originOf(frame.url,frame.origin),visible:prior?.visible??false,fieldCount:prior?.fieldCount??0,focused:prior?.focused??false,heading:prior?.heading||'',lastSeen:Date.now()});
 }
 return registrySummary(tabId);
}
function invalidateNavigation(details,sameDocument=false){
 if(details.tabId<0||details.frameId<0)return;
 const tabId=details.tabId,frameId=details.frameId,nextDocument=details.documentId||'';
 if(sameDocument){
  for(const frame of frameRegistry.values())if(frame.tabId===tabId&&frame.frameId===frameId){frame.url=String(details.url||frame.url).slice(0,2048);frame.origin=originOf(frame.url,details.origin||frame.origin);frame.lastSeen=Date.now();}
  notifyTop(tabId).catch(()=>{});return;
 }
 cancelFrameId(tabId,frameId);
 const previous=latestDocuments.get(documentSlot(tabId,frameId));
 if(previous&&previous!==nextDocument){frameRegistry.delete(frameKey(tabId,frameId,previous));cancelFrame(tabId,frameId,previous);}
 for(const frame of [...frameRegistry.values()]){
  if(frame.tabId!==tabId)continue;
  const affected=frame.frameId===frameId||(!sameDocument&&frame.frameId!==0&&isDescendant(frame,frameId,tabId));
  if(!affected)continue;
  if(frame.frameId===frameId&&nextDocument&&frame.documentId===nextDocument)continue;
  frameRegistry.delete(frameKey(tabId,frame.frameId,frame.documentId));
  latestDocuments.delete(documentSlot(tabId,frame.frameId));
  cancelFrameId(tabId,frame.frameId);
 }
 if(nextDocument){
  const parentFrameId=Number.isInteger(details.parentFrameId)?details.parentFrameId:-1;
  const parent=[...frameRegistry.values()].find(frame=>frame.tabId===tabId&&frame.frameId===parentFrameId);
  const url=String(details.url||'').slice(0,2048),origin=originOf(url,details.origin);
  const key=frameKey(tabId,frameId,nextDocument);
  frameRegistry.set(key,{tabId,frameId,documentId:nextDocument,parentFrameId,depth:parent?parent.depth+1:0,url,origin,visible:false,fieldCount:0,focused:false,heading:'',rect:null,lastSeen:Date.now()});
  latestDocuments.set(documentSlot(tabId,frameId),nextDocument);
 }
 notifyTop(tabId).catch(()=>{});
}
function isDescendant(frame,ancestorFrameId,tabId){
 let parent=frame.parentFrameId,guard=0;
 while(parent>=0&&guard++<16){if(parent===ancestorFrameId)return true;const ancestor=[...frameRegistry.values()].find(item=>item.tabId===tabId&&item.frameId===parent);if(!ancestor)break;parent=ancestor.parentFrameId;}
 return false;
}
if(chrome.webNavigation){
 chrome.webNavigation.onCommitted?.addListener(details=>invalidateNavigation(details,false));
 chrome.webNavigation.onHistoryStateUpdated?.addListener(details=>invalidateNavigation(details,true));
 chrome.webNavigation.onReferenceFragmentUpdated?.addListener(details=>invalidateNavigation(details,true));
}
async function notify(){for(const t of await chrome.tabs.query({})){try{await chrome.tabs.sendMessage(t.id,{type:'captureChanged'});}catch{}}}
function cancelAll(){for(const ctrl of pending.values())ctrl.abort();pending.clear();}
chrome.storage.onChanged.addListener((changes,area)=>{
 if(area==='session'&&changes.capture)cancelAll();
 if(area==='local'&&(changes.token||changes.gateway||changes.consent)){cancelAll();notify().catch(()=>{});}
});
const boundedText=(value,max)=>typeof value==='string'?value.slice(0,max):'';
async function frameState(message,sender){
 const tabId=sender.tab?.id,frameId=sender.frameId??0,documentId=sender.documentId||'';
 if(!Number.isInteger(tabId)||!documentId||!allowed(sender.url,sender.origin))return null;
 const slot=documentSlot(tabId,frameId);let known=latestDocuments.get(slot);
 if(!known){
  await refreshRegistry(tabId);
  known=latestDocuments.get(slot);
  if(known&&known!==documentId)return null;
 }
 if(known&&known!==documentId){
  if(message.type!=='frameHello')return null;
  frameRegistry.delete(frameKey(tabId,frameId,known));cancelFrame(tabId,frameId,known);
 }
 if(!known||known!==documentId){
  if(message.type!=='frameHello'&&message.type!=='frameState')return null;
  latestDocuments.set(slot,documentId);
 }
 const key=frameKey(tabId,frameId,documentId),prior=frameRegistry.get(key);
 if(message.type==='frameBye'){
  if(!prior)return null;
  frameRegistry.delete(key);latestDocuments.delete(slot);cancelFrame(tabId,frameId,documentId);notifyTop(tabId).catch(()=>{});return {ok:true};
 }
 if(message.type==='frameHello'&&!prior){
  const url=String(sender.url||'').slice(0,2048);
  const parentFrameId=Number.isInteger(sender.parentFrameId)?sender.parentFrameId:-1;
  frameRegistry.set(key,{tabId,frameId,documentId,parentFrameId,depth:0,url,origin:originOf(url,sender.origin),visible:false,fieldCount:0,focused:false,heading:'',lastSeen:Date.now()});
  refreshRegistry(tabId).catch(()=>{});
 }
 const frame=frameRegistry.get(key);if(!frame)return null;
 const rect=message.rect;
 frame.visible=message.visible===true;
 frame.fieldCount=Number.isInteger(message.fieldCount)?Math.max(0,Math.min(40,message.fieldCount)):0;
 frame.focused=message.focused===true&&frame.visible;
 frame.heading=boundedText(message.heading,120);
 frame.rect=rect&&['x','y','width','height'].every(k=>Number.isFinite(rect[k])&&Math.abs(rect[k])<=100000)?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null;
 frame.lastSeen=Date.now();
 notifyTop(tabId).catch(()=>{});
 return {ok:true};
}
chrome.runtime.onInstalled.addListener(async details=>{
 await chrome.storage.session.remove('capture');frameRegistry.clear();latestDocuments.clear();await notify();
 if(details.reason==='install')await chrome.runtime.openOptionsPage();
 for(const tab of await chrome.tabs.query({}))await refreshRegistry(tab.id);
});
chrome.runtime.onStartup?.addListener(async()=>{for(const tab of await chrome.tabs.query({}))await refreshRegistry(tab.id);});
chrome.tabs.onRemoved?.addListener(tabId=>{for(const frame of [...frameRegistry.values()])if(frame.tabId===tabId){frameRegistry.delete(frameKey(tabId,frame.frameId,frame.documentId));latestDocuments.delete(documentSlot(tabId,frame.frameId));cancelFrameId(tabId,frame.frameId);}});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 if(m.type==='frameHello'||m.type==='frameState'||m.type==='frameBye'){
  if(!allowed(sender.url,sender.origin))return;
  frameState(m,sender).then(result=>reply(result||{error:'Frame registration is stale.'})).catch(()=>reply({error:'Frame registration failed.'}));return true;
 }
 if(m.type==='frameRegistry'){
  if(!allowed(sender.url,sender.origin)||!sender.tab?.id||sender.frameId!==0)return;
  refreshRegistry(sender.tab.id).then(()=>reply(registrySummary(sender.tab.id))).catch(()=>reply(registrySummary(sender.tab.id)));
  return true;
 }
 if(!allowed(sender.url,sender.origin))return;
 (async()=>{
  await secured;
  if(m.type==='settings'){await chrome.runtime.openOptionsPage();return {};}
  const settings=await chrome.storage.local.get({token:'',gateway:'https://cee.songm.dpdns.org',consent:true});
  if(m.type==='readClipboard'){
    if(!sender.tab?.id)throw Error('Clipboard is unavailable in this frame.');
    const result=await chrome.tabs.sendMessage(sender.tab.id,{type:'readClipboard'},{frameId:0});
    if(!result)throw Error('Clipboard is unavailable on this page.');
    return result;
  }
  if(m.type==='capture'){
    if(!trusted(sender.url))throw Error('Capture is available from the extension button.');
    if(settings.token&&typeof m.text==='string'&&m.text.includes(settings.token)){const saved=await chrome.storage.session.get('capture');if(saved.capture){await chrome.storage.session.remove('capture');await notify();}throw Error('Your token is saved. Copy other text to capture.');}
    const capture={text:m.text,version:crypto.randomUUID()};await chrome.storage.session.set({capture});await notify();return {ok:true};
  }
  if(m.type==='clear'){await chrome.storage.session.remove('capture');await notify();return {};}
  if(m.type==='status'){const saved=await chrome.storage.session.get('capture');if(settings.token&&saved.capture?.text?.includes(settings.token)){await chrome.storage.session.remove('capture');await notify();return {ready:!!settings.gateway&&settings.consent};}return {...saved,ready:!!settings.gateway&&settings.consent};}
  if(m.type==='frameRegistry')return registrySummary(sender.tab.id);
  const key=jobKey(sender);
  if(m.type==='cancel'){pending.get(key)?.abort();pending.delete(key);return {};}
  if(m.type==='ocr'){
    if(!settings.gateway||!settings.consent)throw Error('Add the cee gateway URL in cee settings, then enable matching.');
    if(typeof m.image!=='string'||m.image.length<16||m.image.length>14000000)throw Error('Unsupported image.');
    pending.get(key)?.abort();const ctrl=new AbortController();pending.set(key,ctrl);const timer=setTimeout(()=>ctrl.abort(),30000);
    try{
      const headers={'Content-Type':'application/json'};if(settings.token)headers.Authorization='Bearer '+settings.token;
      const res=await fetch(settings.gateway.replace(/\/+$/,'')+'/api/ocr',{method:'POST',headers,body:JSON.stringify({image:m.image,mime:m.mime||'image/png'}),signal:ctrl.signal});
      if(res.status===401)throw Error('The gateway rejected the cee token. Check it in settings.');
      if(!res.ok){const j=await res.json().catch(()=>({}));throw Error(j.error||('Gateway returned HTTP '+res.status+'.'));}
      return await res.json();
    }catch(e){if(e.name==='AbortError')throw new DOMException('Cancelled','AbortError');throw e;}
    finally{clearTimeout(timer);if(pending.get(key)===ctrl)pending.delete(key);}
  }
  const direct=m.type==='preparePaste';
  if(m.type!=='prepare'&&!direct)throw Error('Unknown request');
  if(!settings.gateway||!settings.consent)throw Error('Add the cee gateway URL in cee settings, then enable matching.');
  const capture=direct?{text:m.text,version:m.version}:(await chrome.storage.session.get('capture')).capture;if(settings.token&&capture?.text?.includes(settings.token)){await chrome.storage.session.remove('capture');await notify();throw Error('Copy the text you want to paste, then capture again.');}if(!capture||capture.version!==m.version)throw Error('Clipboard capture changed.');
  if(!m.context||!Array.isArray(m.context.fields)||m.context.fields.length<1||m.context.fields.length>MAX_FIELDS||m.context.fields.some(f=>!validField(f)))throw Error('Unsupported form.');
  if(capture.text.length>60000)throw Error('Copy a shorter section (up to 60,000 characters).');
  pending.get(key)?.abort();const ctrl=new AbortController();pending.set(key,ctrl);const timeout=m.context.fields.length>8?60000:(capture.text.length>1500?45000:20000);const timer=setTimeout(()=>ctrl.abort(),timeout),start=performance.now();
  try{
    async function current(){
      if(ctrl.signal.aborted)throw new DOMException('Cancelled','AbortError');
      const [latest,saved]=await Promise.all([chrome.storage.local.get({token:'',gateway:'https://cee.songm.dpdns.org',consent:true}),chrome.storage.session.get('capture')]);
      if(!latest.consent||latest.gateway!==settings.gateway||(!direct&&saved.capture?.version!==m.version))throw Error('Settings or capture changed. Focus the field again.');
      if(ctrl.signal.aborted)throw new DOMException('Cancelled','AbortError');
    }
    await current();
    const res=await fetch(settings.gateway.replace(/\/+$/,'')+'/api/fill',{method:'POST',headers:{Authorization:'Bearer '+settings.token,'Content-Type':'application/json'},body:JSON.stringify({text:capture.text,context:m.context}),signal:ctrl.signal});
    if(res.status===401)throw Error('The gateway rejected the cee token. Check it in settings.');
    if(!res.ok){const j=await res.json().catch(()=>({}));throw Error(j.error||('Gateway returned HTTP '+res.status+'.'));}
    const out=await res.json();
    // 响应回来后再复查一次：请求期间改设置/换捕获，结果不可用。
    await current();
    return {rows:out.rows,ms:Math.round(performance.now()-start),model:out.model,version:m.version,...(out.partial?{partial:true,errors:out.errors}:{})};
  }catch(e){if(e.name==='AbortError')throw new DOMException('Cancelled','AbortError');throw e;}
  finally{clearTimeout(timer);if(pending.get(key)===ctrl)pending.delete(key);}
 })().then(reply).catch(e=>reply({error:e.name==='AbortError'?'Matching cancelled or timed out.':e.message}));return true;
});

// _execute_action covers both the browser button and Command+J without a popup.
chrome.action.onClicked.addListener(async tab=>{
 if(!tab.id)return;
 try{await chrome.tabs.sendMessage(tab.id,{type:'showToolbar'});await chrome.action.setBadgeText({tabId:tab.id,text:''});await chrome.action.setTitle({tabId:tab.id,title:'Show cee'});}
 catch{await chrome.action.setBadgeText({tabId:tab.id,text:'!'});await chrome.action.setTitle({tabId:tab.id,title:'Refresh this page to show cee. Browser internal pages are unsupported.'});}
});
