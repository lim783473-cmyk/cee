(()=>{
 if(globalThis.__smartPaste)return;globalThis.__smartPaste=true;
 const A=SmartPasteAdapters;
 let capture=null,configured=false,seq=0,timer,prepared=null,busy=false,changes=[],host,root,status,preview,source;
 let stopped=false,pasteJob=null,hideTimer,registryRefresh=null,frameStateTimer=0;
 let registrySummary={frames:[],active:null};
 const isTop=(()=>{try{return window.top===window;}catch{return true;}})();
 const topReadable=(()=>{if(isTop)return true;try{return !!window.top.document;}catch{return false;}})();
 const events=new AbortController();
 function hidePanel(){clearTimeout(hideTimer);hideTimer=null;host?.remove();host=null;root=null;status=null;preview=null;source=null;}
 function frameUsable(){
  if(isTop)return true;
  try{return window.innerWidth>=2&&window.innerHeight>=2&&document.visibilityState!=='hidden'&&self.origin!=='null';}catch{return false;}
 }
 function frameMeta(){
  const visible=frameUsable(),focused=visible&&document.hasFocus()&&!!A.snapshot(document.activeElement),snapshot=focused?A.snapshot(document.activeElement):null,el=snapshot?.focus,rect=el?.getBoundingClientRect?.();
  return {type:'frameState',visible,focused,fieldCount:focused?snapshot.fields.length:0,heading:focused?snapshot.heading:'',...(rect?{rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}:{})};
 }
 function reportFrame(type='frameState'){
  if(stopped)return;
  if(type==='frameState'){
   clearTimeout(frameStateTimer);
   frameStateTimer=setTimeout(()=>send(frameMeta()).catch(()=>{}),80);
  }else send({type}).catch(()=>{});
 }
 async function refreshFrameRegistry(){
  if(!isTop)return registrySummary;
  if(registryRefresh)return registryRefresh;
  registryRefresh=send({type:'frameRegistry'}).then(summary=>{
   if(summary&&Array.isArray(summary.frames))registrySummary=summary;
   return registrySummary;
  }).finally(()=>{registryRefresh=null;});
  return registryRefresh;
 }
 function activeFrameStatus(){
  const active=registrySummary.active;
  if(!active)return null;
  if(active.frameId===0)return active.fieldCount?`本页有活动表单（${active.heading||'表单'}）`:null;
  return `嵌入框架中有活动表单（${active.origin}）`;
 }
 function shutdown(){
  if(stopped)return;stopped=true;seq++;clearTimeout(timer);events.abort();hidePanel();
  capture=null;prepared=null;configured=false;
  try{chrome.runtime.onMessage.removeListener(onMessage);}catch{}
 }
 function connected(){
  if(stopped)return false;
  try{if(chrome.runtime?.id)return true;}catch{}
  shutdown();return false;
 }
 async function send(m){
  if(!connected())return {error:'扩展已重新加载，请刷新此页面。'};
  try{return await chrome.runtime.sendMessage(m);}
  catch(error){
   if(!connected()||/extension context invalidated/i.test(error?.message||'')){shutdown();return {error:'扩展已重新加载，请刷新此页面。'};}
   throw error;
  }
 }
 function panel(force=false){
  if(host)return;
  if(!isTop&&!force)return;
  host=document.createElement('div');host.setAttribute('data-smart-paste','');host.setAttribute('data-cee-frame',isTop?'top':'child');
  host.style.cssText=`position:fixed;bottom:${isTop?24:12}px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:calc(100% - 16px)`;
  root=SmartPasteUI.mountToolbar(host,{shadow:true});
  document.documentElement.append(host);status=root.querySelector('[role=status]');preview=root.querySelector('#preview');source=root.querySelector('pre');
  root.querySelector('#settings').onclick=()=>send({type:'settings'}).catch(()=>show('无法打开设置，请重试。','error'));
  root.querySelector('#close').onclick=()=>{invalidate();hidePanel();};
  root.querySelector('#retry').onclick=()=>{const focus=prepared?.snapshot.focus||lastFocus;if(focus){focus.focus();schedule(focus);}};
  root.querySelector('#original').onclick=async()=>{
   if(busy||!capture)return;
   const snapshot=prepared?.snapshot||A.snapshot(lastFocus);
   if(!snapshot||!A.fresh(snapshot)){show('请重新聚焦该字段。','error');return;}
   const focused=snapshot.fields.find(f=>f.el===snapshot.focus);if(!focused)return;
   busy=true;show('正在粘贴原文…','preparing');
   try{const result=await A.apply(snapshot,{[focused.id]:capture.text});changes=result.changes;invalidate();show(result.verified?'已粘贴原文。':withCodes(result.error||'页面没有保留粘贴的原文。',issueCodes(result)),result.verified?'pasted':'error');}catch(e){show(errorText(e),'error');}finally{busy=false;}
  };
  root.querySelector('#undo').onclick=async()=>{if(busy)return;busy=true;invalidate();try{const n=await A.undo(changes);show(n?`已恢复 ${n} 个字段。`:'没有可撤销的更改。');changes=[];}catch(e){show(e.message);}finally{busy=false;}};
 }
 let lastFocus=null;
 let ocrPreview=null,ocrResolve=null,ocrOpen=false;
 const show=(text,state='captured')=>{
  if(root)SmartPasteUI.setToolbarState(root,state,text);
  if(!isTop&&host){
   clearTimeout(hideTimer);hideTimer=null;
   if(state!=='preparing')hideTimer=setTimeout(()=>{if(!busy&&!ocrOpen&&!stopped)hidePanel();},7000);
  }
 };
 const ROW_REASONS=new Set(['no_exact_option','multiple_exact_options','option_disabled','invalid_url','url_host_mismatch','answer_too_long','answer_too_short']);
 function codeText(codes){
  const list=[...new Set(codes.filter(Boolean))];
  return list.length?`（${list.slice(0,3).join('、')}${list.length>3?'、…':''}）`:'';
 }
 function withCodes(text,codes){
  const suffix=codeText(codes);
  return suffix?`${String(text).replace(/[.。]$/,'')}${suffix}。`:text;
 }
 function issueCodes(result){return (result.issues||[]).map(issue=>issue.code);}
 function pageRejectedCount(result){return new Set((result.issues||[]).filter(issue=>issue.code==='page_rejected').map(issue=>issue.id)).size;}
 function rowNote(rows,partial){
  const skipped=(rows||[]).filter(row=>row.reason&&ROW_REASONS.has(row.reason));
  const notes=[];
  if(partial)notes.push('部分字段未能匹配。');
  if(skipped.length)notes.push(`跳过 ${skipped.length} 个字段${codeText(skipped.map(row=>row.reason))}。`);
  return notes.length?' '+notes.join(' '):'';
 }
 function errorText(error,fallback='没有找到匹配项。'){
  const raw=error?.message||'';
  const message=/^Failed to fetch$/i.test(raw)?'无法连接 cee 网关，请检查网络或网关地址。':raw||fallback;
  return error?.code?withCodes(message,[error.code]):message;
 }
 function pasteStatus(result){
  const rejected=result.rejected?.length||0,failed=new Set(result.failed||[]),ok=Math.max(0,result.changes.length-failed.size);
  const codes=issueCodes(result),page=pageRejectedCount(result);
  if(rejected)return withCodes(`${rejected} 个字段因长度限制被拒绝`,codes);
  if(result.verified)return `已填入 ${result.changes.length} 个字段。`;
  if(page){
   if(ok>0)return withCodes(`已填入 ${ok} 个字段，${page} 个被页面拒绝`,codes);
   return withCodes((result.error||'页面拒绝了粘贴的值').replace(/\s+Review the form; Undo is available\.?$/,''),codes);
  }
  if(failed.size&&ok>0)return withCodes(`已填入 ${ok} 个字段，${failed.size} 个被页面重置`,codes);
  return withCodes(result.error||'页面没有保留所有字段。',codes);
 }
 function finishOcr(value){if(!ocrOpen)return;ocrOpen=false;ocrPreview?.close();ocrPreview=null;const r=ocrResolve;ocrResolve=null;r?.(value);}
 function invalidate(){seq++;pasteJob=null;prepared=null;clearTimeout(timer);finishOcr(null);preview?.replaceChildren();send({type:'cancel'}).catch(()=>{});}
 let refreshing=null;
 function refresh(){if(refreshing)return refreshing;refreshing=refreshState().finally(()=>{refreshing=null;});return refreshing;}
 async function refreshState(){
  const s=await send({type:'status'});if(stopped)return;
  const changed=capture?.version!==s.capture?.version||configured!==s.ready;
  if(!changed)return;
  invalidate();if(stopped)return;capture=s.capture;configured=s.ready;
  if(!capture){hidePanel();return;}
  if(host&&source)source.textContent=capture.text;
  if(!configured&&host&&!busy&&!pasteJob)show('请先在 cee 设置里填写网关地址。','error');
 }
 function schedule(focus){
  if(!connected()||busy)return;
  invalidate();if(stopped)return;
  if(A.snapshot(focus)){lastFocus=focus;if(isTop)show('聚焦表单字段后按 Alt+V 填入。');}
  else if(isTop)show('聚焦一个文本字段。');
 }
 document.addEventListener('focusin',e=>{if(!connected()||ocrOpen)return;if(e.composedPath().includes(host))return;reportFrame('frameState');if(busy)return;if(A.snapshot(e.target)){if(pasteJob?.snapshot.focus===e.target&&A.fresh(pasteJob.snapshot))return;schedule(e.target);}else if(capture||host){invalidate();show('聚焦一个文本字段。');}},{capture:true,signal:events.signal});
 document.addEventListener('input',e=>{if(!connected()||ocrOpen)return;if(!e.composedPath().includes(host)){reportFrame('frameState');if(!busy)schedule(document.activeElement);}},{capture:true,signal:events.signal});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!busy&&!ocrOpen){invalidate();show('已取消。');}},{capture:true,signal:events.signal});
 // Smart fill is opt-in per keystroke: Alt+V reads the clipboard and runs the
 // match. Plain Ctrl+V is never intercepted, and when no confident match
 // exists the original text is pasted instead so nothing the user copies is
 // ever lost to a failed match.
 // isComposing/keyCode 229: an IME mid-conversion (pinyin 'v' mode) must keep the keystroke.
 const smartKey=e=>!e.isComposing&&e.keyCode!==229&&e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&(e.key==='v'||e.key==='V');
 // Clipboard may hold text or a screenshot. Text keeps the existing path; an
 // image is OCR'd by the gateway and shown for confirmation before any fill.
 async function readLocalClipboard(){
  if(navigator.clipboard?.read){
   try{
    const items=await navigator.clipboard.read();
    for(const item of items){
     const textType=item.types?.find(t=>t==='text/plain');
     if(textType){const t=await (await item.getType(textType)).text();if(t&&t.trim())return{kind:'text',text:t};}
     const imgType=item.types?.find(t=>t==='image/png'||t==='image/jpeg');
     if(imgType)return{kind:'image',blob:await item.getType(imgType),mime:imgType};
    }
   }catch{}
  }
  return {kind:'text',text:await navigator.clipboard.readText()};
 }
 async function readClipboardFromTop(error){
  const remote=await send({type:'readClipboard'});
  if(remote?.error)throw Error(remote.error);
  if(remote?.kind==='image'&&remote.base64)return {kind:'image',base64:remote.base64,mime:remote.mime};
  if(remote?.kind==='text')return {kind:'text',text:remote.text};
  throw error||Error('此页面无法读取剪贴板。');
 }
 async function readClipboard(){
  // Cross-origin iframes usually block clipboard-read unless the embedder
  // opts in with allow="clipboard-read"; calling it there only logs a
  // Permissions Policy violation. Use the focused top document directly.
  if(!isTop&&!topReadable)return readClipboardFromTop();
  try{return await readLocalClipboard();}
  catch(error){
   if(isTop)throw error;
   return readClipboardFromTop(error);
  }
 }
 function bytesToBase64(bytes){let bin='';for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(bin);}
 function blobBytes(blob){return blob.arrayBuffer?blob.arrayBuffer():new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsArrayBuffer(blob);});}
 async function imageToBase64(blob,mime,maxSide=1600){
  let out=blob,type=mime;
  if(typeof createImageBitmap==='function'){
   const bmp=await createImageBitmap(blob);
   const scale=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
   if(scale<1&&typeof OffscreenCanvas==='function'){
    const c=new OffscreenCanvas(Math.round(bmp.width*scale),Math.round(bmp.height*scale));
    c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
    out=await c.convertToBlob({type:'image/png'});type='image/png';
   }
   bmp.close?.();
  }
  return {base64:bytesToBase64(new Uint8Array(await blobBytes(out))),mime:type};
 }
 function askOcrPreview(text){return new Promise(resolve=>{ocrOpen=true;ocrResolve=resolve;ocrPreview=SmartPasteUI.mountOcrPreview(text,{onConfirm:finishOcr,onCancel:()=>finishOcr(null)});});}
 async function smartPaste(){
  if(!connected()||busy||ocrOpen)return;
  const snapshot=A.snapshot(document.activeElement);
  if(!snapshot||!frameUsable())return;
  if(!configured){panel(true);show('请先在 cee 设置里填写网关地址。','error');return;}
  if(pasteJob?.snapshot.focus===snapshot.focus&&A.fresh(pasteJob.snapshot))return;
  pasteJob={text:'',snapshot};panel(true);show('正在读取剪贴板…','preparing');
  let text;
  try{
   const clip=await readClipboard();
   if(clip.kind==='image'){
    show('正在识别截图…','preparing');
    const image=clip.base64?{base64:clip.base64,mime:clip.mime||'image/png'}:await imageToBase64(clip.blob,clip.mime);
    if(stopped)return;
    const ocr=await send({type:'ocr',image:image.base64,mime:image.mime});
    if(stopped)return;
    if(ocr.error)throw Error(ocr.error);
    const recognized=String(ocr.text||'').trim();
    if(!recognized){pasteJob=null;show('截图中没有识别到文字，请改为复制文字。','error');return;}
    const edited=await askOcrPreview(recognized);
    if(stopped||edited===null){pasteJob=null;if(!stopped)show('已取消。');return;}
    text=edited;
    try{snapshot.focus.focus();}catch{}
   }else text=clip.text;
  }catch(e){pasteJob=null;if(!stopped)show(errorText(e,'无法读取剪贴板，请按 Ctrl+V 或允许剪贴板访问。'),'error');return;}
  if(stopped||!text){pasteJob=null;return;}
  if(!connected())return;
  if(!A.fresh(snapshot)||document.activeElement!==snapshot.focus){show('请重新聚焦该字段。','error');return;}
  invalidate();const token=seq;pasteJob={text,snapshot};let applying=false;panel(true);lastFocus=snapshot.focus;show('正在查找匹配项…','preparing');
  try{
   const response=await send({type:'preparePaste',text,version:'paste-'+token,context:A.context(snapshot)});
   if(stopped||token!==seq||document.activeElement!==snapshot.focus||!A.fresh(snapshot))return;
   if(response.error)throw Error(response.error);
   if(!isTop&&!frameUsable())throw Error('该表单已不可见。');
   const selected={};
   for(const row of response.rows||[]){if(row.confident&&row.selected){const option=row.options.find(o=>o.id===row.selected);if(!option)continue;const field=snapshot.fields.find(f=>f.id===row.id);let value=option.text;if(field?.kind==='select'){if(typeof option.value==='string'&&option.value!=='')value=field.el.options?Array.from(field.el.options).find(o=>o.value===option.value&&!o.disabled&&!o.parentElement?.disabled&&SmartPasteAdapters.normalizeOption(o.text)===SmartPasteAdapters.normalizeOption(option.text))?.text||option.text:option.text;else if(option.sourceText)value=option.sourceText;else value=field.el.selectedOptions?.[0]?.text||value;}else if(field?.kind==='combobox')value=option.text;selected[row.id]=value;}}
   if(stopped||token!==seq||document.activeElement!==snapshot.focus||!A.fresh(snapshot))return;
   if(!isTop&&!frameUsable())throw Error('该表单已不可见。');
   if(!Object.keys(selected).length){
    busy=true;applying=true;show('正在粘贴原文…','preparing');
    const field=snapshot.fields.find(f=>f.focused);
    const result=await A.apply(snapshot,{[field.id]:text});changes=result.changes;invalidate();
    show(result.verified?'没有智能匹配，已粘贴原文。':withCodes(result.error||'页面没有保留粘贴的原文。',issueCodes(result)),result.verified?'pasted':'error');
    return;
   }
   busy=true;applying=true;show('正在填入…','preparing');
   const result=await A.apply(snapshot,selected);changes=result.changes;invalidate();
   const note=rowNote(response.rows,response.partial);
   const skipped=(response.rows||[]).filter(row=>row.reason&&ROW_REASONS.has(row.reason)).length;
   show(pasteStatus(result)+note,result.verified&&!response.partial&&!skipped?'pasted':'error');
  }catch(error){if(token===seq)show(errorText(error),'error');}finally{if(token===seq)pasteJob=null;if(applying)busy=false;}
 }
 document.addEventListener('keydown',e=>{if(smartKey(e)){e.preventDefault();e.stopImmediatePropagation();smartPaste();}},{capture:true,signal:events.signal});
 function onMessage(m,sender,sendResponse){
  if(!connected())return;
  if(m.type==='readClipboard'){
   if(!isTop){sendResponse({error:'剪贴板由顶层页面读取。'});return false;}
   readClipboard().then(async clip=>{
    if(clip.kind==='image'){
     const image=clip.base64?clip:await imageToBase64(clip.blob,clip.mime);
     sendResponse({kind:'image',base64:image.base64,mime:image.mime});
    }else sendResponse({kind:'text',text:clip.text});
   }).catch(error=>sendResponse({error:error?.message||'无法读取剪贴板。'}));
   return true;
  }
  if(m.type==='showToolbar'){
   if(!isTop)return;
   panel();
   send({type:'status'}).then(s=>{if(stopped)return;configured=s.ready;if(!pasteJob&&!busy)show(activeFrameStatus()||(configured?'聚焦表单字段后按 Alt+V 填入。':'请先在 cee 设置里填写网关地址。'));}).catch(()=>show('无法读取设置。','error'));
  }else if(m.type==='captureChanged')refresh().catch(e=>{if(isTop&&host)show(e.message);});
  else if(m.type==='frameRegistryChanged'&&isTop)refreshFrameRegistry().then(()=>{
   if(host&&!capture&&!busy&&!pasteJob)show(activeFrameStatus()||'聚焦表单字段后按 Alt+V 填入。');
  }).catch(()=>{});
 }
 try{chrome.runtime.onMessage.addListener(onMessage);}catch{shutdown();}
 window.addEventListener('blur',()=>{
  if(!isTop)reportFrame('frameState');
  if(!busy&&!ocrOpen&&host){
   const el=document.activeElement;
   if(isTop&&el&&(el.tagName==='IFRAME'||el.tagName==='FRAME')){refreshFrameRegistry().then(()=>{const active=activeFrameStatus();if(host&&!stopped)show(active||'聚焦表单字段后按 Alt+V 填入。');}).catch(()=>{});return;}
   if(isTop){refreshFrameRegistry().then(()=>{const active=activeFrameStatus();if(host&&!stopped)show(active||'聚焦表单字段后按 Alt+V 填入。');}).catch(()=>{});return;}
   invalidate();show('已取消。');
  }
 },{signal:events.signal});
 window.addEventListener('focus',()=>{if(connected()&&!busy){if(!isTop)reportFrame('frameState');else refresh().catch(()=>{});}},{signal:events.signal});
 window.addEventListener('resize',()=>reportFrame('frameState'),{signal:events.signal});
 window.addEventListener('scroll',()=>reportFrame('frameState'),{capture:true,passive:true,signal:events.signal});
 document.addEventListener('visibilitychange',()=>reportFrame('frameState'),{signal:events.signal});
 window.addEventListener('pagehide',()=>reportFrame('frameBye'),{once:true,signal:events.signal});
 try{chrome.runtime.sendMessage({type:'frameHello'}).then(()=>reportFrame('frameState')).catch(()=>{});}catch{}
 refresh().catch(()=>{});
})();
