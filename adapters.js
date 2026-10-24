(function(root){
  const selector='input,textarea,select,input[role=combobox][aria-autocomplete="list"],input[role=combobox][aria-autocomplete="both"],[contenteditable=true],[contenteditable=plaintext-only]';
  const MAX_FIELDS=40;
  const read=e=>e.isContentEditable?e.innerText:e.value;
  const rootOf=e=>{try{return e.getRootNode?.()||e.ownerDocument;}catch{return e.ownerDocument;}};
  // Chrome content scripts can read closed roots with chrome.dom; Firefox uses
  // the element property. Safari only exposes open roots through .shadowRoot.
  function shadowRootOf(e){
    if(!e||e.nodeType!==1)return null;
    if(e.shadowRoot)return e.shadowRoot;
    const dom=root.chrome?.dom;
    if(dom?.openOrClosedShadowRoot){try{return dom.openOrClosedShadowRoot(e);}catch{}}
    if(e.openOrClosedShadowRoot)return e.openOrClosedShadowRoot;
    return null;
  }
  function composedParent(e){
    if(e.parentElement)return e.parentElement;
    const r=rootOf(e);
    return r?.host||null;
  }
  function composedClosest(e,sel){
    for(let n=e;n;n=composedParent(n))if(n.nodeType===1&&n.matches?.(sel))return n;
    return null;
  }
  // scope.contains does not cross shadow boundaries; walk up through hosts.
  function deepContains(scope,el){
    if(!scope||!el)return false;
    if(scope===el||scope.contains?.(el))return true;
    for(let n=el;n;){
      if(n===scope)return true;
      const r=rootOf(n);
      if(r&&r!==n&&r.host){n=r.host;continue;}
      n=n.parentNode;
    }
    return false;
  }
  function scopeConnected(scope){
    if(!scope)return false;
    if(scope.host)return !!scope.host.isConnected;
    if(scope.nodeType===9)return true;
    return !!scope.isConnected;
  }
  function label(e){
    const r=rootOf(e);
    const byId=id=>{
      try{return (r?.getElementById?.(id)||e.ownerDocument?.getElementById?.(id))?.textContent||'';}
      catch{return '';}
    };
    const parts=[e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.getAttribute('data-placeholder'),...(e.getAttribute('aria-labelledby')||'').split(/\s+/).map(byId),...Array.from(e.labels||[],l=>l.textContent),e.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')]
      .map(v=>String(v||'').trim().replace(/\s+/g,' ')).filter(Boolean);
    const seen=new Set();
    return parts.filter(v=>{const k=v.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;}).join(' ');
  }
  function comboLists(el){
    const scope=rootOf(el),ids=(el.getAttribute('aria-controls')||'').trim().split(/\s+/).filter(Boolean);
    return ids.map(id=>scope?.getElementById?.(id)).filter(list=>list?.getAttribute('role')==='listbox');
  }
  function comboOptions(el){
    return comboLists(el).filter(list=>!list.hidden&&list.getAttribute('aria-hidden')!=='true').flatMap(list=>Array.from(list.querySelectorAll('[role=option]')).slice(0,80).map(option=>({
      text:String(option.innerText||option.textContent||'').trim().replace(/\s+/g,' ').slice(0,160),
      disabled:option.getAttribute('aria-disabled')==='true'||option.matches('[disabled]'),
      selected:option.getAttribute('aria-selected')==='true'
    })).filter(option=>option.text)).slice(0,80);
  }
  function comboHidden(el){
    const out=[];
    for(const list of comboLists(el)){
      const owner=list.closest('[data-combobox-root]')||list.parentElement;
      const input=owner?.querySelector('input[type=hidden]');
      if(input&&!out.includes(input))out.push(input);
    }
    return out;
  }
  function supported(e){
    if(!e?.matches?.(selector)||e.disabled||e.matches(':disabled')||e.readOnly||composedClosest(e,'[hidden],[inert],[aria-hidden="true"]')||!e.getClientRects().length)return false;
    if(e.matches?.('input[role=combobox]'))return !!label(e)&&comboLists(e).length>0;
    if(e.tagName==='SELECT')return true;
    if(e.tagName==='INPUT'&&!['text','email','tel','url'].includes(e.type))return false;
    const purpose=[label(e),e.name,e.id,e.getAttribute('autocomplete')].filter(Boolean).join(' ');
    return !/password|passcode|one.?time|otp|verification.?code|security.?code|api.?key|secret|token|credit.?card|card.?number|cardholder|cvv|cvc|cc-|social.?security|ssn/i.test(purpose);
  }
  function kind(e){if(e.tagName==='SELECT')return 'select';if(e.matches?.('input[role=combobox]'))return 'combobox';const l=label(e);if(/issue title|add title|^title\b|subject/i.test(l))return 'title';if(/description|add more details|message|comments|details/i.test(l))return 'description';return e.tagName==='INPUT'&&['email','tel','url'].includes(e.type)?e.type:'text';}
  // Depth-first collection that crosses open/closed shadow roots. Scope is a
  // form/dialog when possible, so this stays bounded on large pages.
  function deepQueryAll(scope,query,maxDepth=8){
    const out=[],elements=new Set(),roots=new Set();
    const visit=(node,depth)=>{
      if(!node||depth>maxDepth)return;
      if(node.nodeType===1){
        if(node.matches?.(query)&&!elements.has(node)){elements.add(node);out.push(node);}
        const sr=shadowRootOf(node);
        if(sr&&!roots.has(sr)){roots.add(sr);visit(sr,depth+1);}
      }
      for(const child of node.children?Array.from(node.children):[])visit(child,depth);
    };
    visit(scope,0);
    return out;
  }
  function priority(el,focus,index){
    const text=label(el);
    let score=0;
    if(el===focus)score+=1000;
    if(el.required||el.getAttribute('aria-required')==='true'||/[*＊]|必填/.test(text))score+=100;
    if(/name|姓名|email|邮箱|phone|电话|mobile|手机|address|地址|company|公司|organization|组织|title|职位|position|location|地点|city|城市|linkedin|github|website|网址/i.test(text))score+=50;
    if(el.tagName==='TEXTAREA')score-=10;
    return score;
  }
  function snapshot(focus){
    if(!supported(focus))return null;
    // Prefer the outer form/dialog. Many design systems wrap every field in
    // its own fieldset; using the nearest fieldset would capture one field only.
    const group=composedClosest(focus,'form,[role=form],dialog,[role=dialog]')||composedClosest(focus,'fieldset');
    const scope=group||rootOf(focus)||focus.parentElement;if(!scope)return null;
    const candidates=group?deepQueryAll(scope,selector):[focus];
    const eligible=candidates.filter(el=>supported(el)&&(el===focus||(el.tagName==='SELECT'?el.value==='':!read(el).trim())));
    // Keep the focused field and fill the highest-value/required fields first;
    // DOM order is only the tie-breaker. IDs stay in DOM order for stable UI.
    const selected=new Set([focus,...eligible
      .map((el,i)=>({el,i,score:priority(el,focus,i)}))
      .sort((a,b)=>b.score-a.score||a.i-b.i)
      .slice(0,MAX_FIELDS)
      .map(x=>x.el)]);
    const fields=eligible.filter(el=>selected.has(el)).map((el,i)=>({id:'f'+i,kind:kind(el),label:(label(el)||el.name||'Text field').slice(0,160),el,before:read(el),focused:el===focus,...(el.matches?.('input[role=combobox]')?{combo:{hidden:comboHidden(el),hiddenBefore:comboHidden(el).map(input=>input.value)}}:{})}));
    if(!fields.some(f=>f.el===focus))return null;
    const headingEl=group?deepQueryAll(scope,'h1,h2,legend,[role=heading]')[0]:null;
    const heading=(headingEl?.textContent||scope.getAttribute?.('aria-label')||scope.host?.getAttribute?.('aria-label')||'表单').slice(0,160);
    return {scope,focus,heading,fields};
  }
  function context(s){
    return {heading:s.heading,fields:s.fields.map(f=>({
      id:f.id,kind:f.kind,label:f.label,focused:f.focused,occupied:f.kind==='combobox'?false:!!f.before,
      tag:f.el.tagName.toLowerCase(),
      ...(f.el.id?{elementId:f.el.id.slice(0,120)}:{}),
      ...(f.el.tagName==='SELECT'?{options:Array.from(f.el.options).slice(0,80).map(o=>({text:o.text.trim().slice(0,160),value:o.value,disabled:o.disabled||o.parentElement?.disabled||false,selected:o.selected}))}:{}),
      ...(f.kind==='combobox'?{options:comboOptions(f.el),hasCommittedInput:!!f.combo?.hidden.length}:{}),
      ...(f.el.tagName==='TEXTAREA'||f.el.tagName==='INPUT'?{
        ...(Number.isFinite(f.el.maxLength)&&f.el.maxLength>=0?{maxLength:f.el.maxLength}:{}),
        ...(Number.isFinite(f.el.minLength)&&f.el.minLength>=0?{minLength:f.el.minLength}:{}),
        ...(f.el.tagName==='TEXTAREA'?{rows:f.el.rows}:{}),
        ...(f.el.autocomplete?{autocomplete:f.el.autocomplete}:{}),
        ...(f.el.name?{name:f.el.name.slice(0,120)}:{})
      }:{}),
      ...(f.el.getAttribute('role')?{role:f.el.getAttribute('role')}:{}),
      required:!!(f.el.required||f.el.getAttribute('aria-required')==='true'),
      ...(f.el.getAttribute('aria-autocomplete')?{ariaAutocomplete:f.el.getAttribute('aria-autocomplete')}:{}),
      ...(f.el.getAttribute('aria-controls')?{ariaControls:f.el.getAttribute('aria-controls').slice(0,160)}:{})
    }))};
  }
  const fresh=s=>scopeConnected(s.scope)&&s.fields.every(f=>supported(f.el)&&f.el.isConnected&&deepContains(s.scope,f.el)&&read(f.el)===f.before);
  function dispatch(el,type,init){
    const w=el.ownerDocument.defaultView;
    let ev;
    try{ev=type==='input'&&w.InputEvent?new w.InputEvent(type,init):new w.Event(type,init);}
    catch{ev=new w.Event(type,{bubbles:true,composed:true});}
    el.dispatchEvent(ev);
  }
  function coded(message,code){const error=Error(message);error.code=code;return error;}
  function write(el,text){
    el.focus();
    if(el.matches?.('input[role=combobox]'))throw Error('Use the committed combobox writer.');
    if(el.tagName==='SELECT'){
      const wanted=normOption(text);
      const exact=Array.from(el.options).filter(o=>normOption(o.text)===wanted);
      const matches=exact.filter(o=>!o.disabled&&!o.parentElement?.disabled&&o.value!=='');
      if(matches.length!==1){
        if(matches.length>1)throw coded('存在多个完全匹配的选项。','multiple_exact_options');
        if(exact.some(o=>o.disabled||o.parentElement?.disabled))throw coded('完全匹配的选项已禁用。','option_disabled');
        throw coded('没有完全匹配的选项。','no_exact_option');
      }
      el.value=matches[0].value;
      dispatch(el,'input',{bubbles:true,composed:true});
      dispatch(el,'change',{bubbles:true,composed:true});
      return;
    }
    if(el.isContentEditable){
      const sel=el.ownerDocument.getSelection(),r=el.ownerDocument.createRange();
      r.selectNodeContents(el);sel.removeAllRanges();sel.addRange(r);
      if(!el.ownerDocument.execCommand('insertText',false,text))throw coded('编辑器拒绝了粘贴内容。','page_rejected');
    }else{
      const w=el.ownerDocument.defaultView,p=el.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype;
      const desc=Object.getOwnPropertyDescriptor(p,'value');
      if(desc?.set)desc.set.call(el,text);else el.value=text;
      // Synthetic events default to composed:false and would stop at the shadow
      // boundary, so React/framework listeners above the host would never see them.
      dispatch(el,'input',{bubbles:true,composed:true,inputType:'insertText',data:text});
      dispatch(el,'change',{bubbles:true,composed:true});
    }
  }
  function normOption(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();}
  function normalizeOption(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();}
  function newlineNormalized(value){return String(value??'').replace(/\r\n?/g,'\n');}
  function sameValue(el,expected){
    const actual=read(el);
    if(actual===expected)return true;
    if(el.tagName==='SELECT')return normOption(el.selectedOptions?.[0]?.text)===normOption(expected);
    if(el.tagName==='INPUT'&&el.type==='tel'){
      const a=actual.replace(/\D/g,''),b=String(expected??'').replace(/\D/g,'');
      if(a&&b&&a===b)return true;
    }
    const a=newlineNormalized(actual),b=newlineNormalized(expected);
    return a===b||a.trim()===b.trim();
  }
  // A typing-like fallback for pages that ignore a single synthetic input event.
  // execCommand is deprecated but still the only content-script way to emit a
  // native insertText without CDP; it is used only after the normal write fails.
  function typeFallback(el,text){
    try{
      if(el.isContentEditable){
        const doc=el.ownerDocument,sel=doc.getSelection(),r=doc.createRange();
        r.selectNodeContents(el);sel.removeAllRanges();sel.addRange(r);
        return !!doc.execCommand('insertText',false,text);
      }
      if(!el.select)return false;
      el.focus();el.select();
      return !!el.ownerDocument.execCommand('insertText',false,text);
    }catch{return false;}
  }
  function setInputValue(el,value){
    const desc=Object.getOwnPropertyDescriptor(el.ownerDocument.defaultView.HTMLInputElement.prototype,'value');
    if(desc?.set)desc.set.call(el,value);else el.value=value;
    dispatch(el,'input',{bubbles:true,composed:true,inputType:'insertText',data:value});
  }
  function restoreHidden(inputs,values){inputs.forEach((input,i)=>{if(input.isConnected){setInputValue(input,values[i]??'');dispatch(input,'change',{bubbles:true,composed:true});}});}
  function pageInvalid(el){
    if(!el?.isConnected)return false;
    const aria=el.getAttribute?.('aria-invalid');
    // ARIA: absent, 'false', empty, 'grammar' and 'spelling' are not a value-format rejection.
    if(aria==='true'||(!!aria&&!['false','grammar','spelling'].includes(aria)))return true;
    try{
      if(el.validity&&el.validity.valid===false)return true;
      return typeof el.validationMessage==='string'&&el.validationMessage.trim()!=='';
    }catch{return false;}
  }
  function restoreValue(el,value,focus=true){
    const next=String(value??'');
    if(el.tagName==='SELECT'){
      el.value=next;
      dispatch(el,'input',{bubbles:true,composed:true});
      dispatch(el,'change',{bubbles:true,composed:true});
      return;
    }
    if(!focus&&!el.isContentEditable){
      const w=el.ownerDocument.defaultView,p=el.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype;
      const desc=Object.getOwnPropertyDescriptor(p,'value');
      if(desc?.set)desc.set.call(el,next);else el.value=next;
      dispatch(el,'input',{bubbles:true,composed:true,inputType:'insertText',data:next});
      dispatch(el,'change',{bubbles:true,composed:true});
      return;
    }
    write(el,next);
  }
  function restoreChange(change,focus=true){
    if(!change.el.isConnected)return false;
    if(change.kind==='combobox'){
      setInputValue(change.el,String(change.before??''));
      restoreHidden(change.combo?.hidden||[],change.combo?.hiddenBefore||[]);
      dispatch(change.el,'change',{bubbles:true,composed:true});
    }else restoreValue(change.el,change.before,focus);
    return true;
  }
  async function writeCombobox(field,text,wait){
    const el=field.el,lists=comboLists(el),wanted=normOption(text),before=String(field.before??''),hidden=field.combo?.hidden||comboHidden(el),hiddenBefore=field.combo?.hiddenBefore||hidden.map(input=>input.value);
    if(!lists.length)throw coded('组合框没有可控列表。','page_changed');
    const rollback=()=>{if(normOption(read(el))!==wanted)return;setInputValue(el,before);restoreHidden(hidden,hiddenBefore);dispatch(el,'change',{bubbles:true,composed:true});};
    el.focus();setInputValue(el,text);
    const deadline=Date.now()+1500;let matches=[],all=[];
    do{
      if(!el.isConnected||el.ownerDocument.activeElement!==el||normOption(read(el))!==wanted)break;
      all=lists.filter(list=>!list.hidden&&list.getAttribute('aria-hidden')!=='true').flatMap(list=>Array.from(list.querySelectorAll('[role=option]')).map(option=>({list,option,text:normOption(option.textContent)})).filter(hit=>hit.text===wanted));
      matches=all.filter(({option})=>!option.matches('[disabled]')&&option.getAttribute('aria-disabled')!=='true');
      if(matches.length)break;
      await wait(50);
    }while(Date.now()<deadline);
    if(!el.isConnected||el.ownerDocument.activeElement!==el||normOption(read(el))!==wanted){rollback();throw coded('等待选项时组合框发生了变化。','page_changed');}
    if(matches.length!==1){
      rollback();
      if(matches.length>1)throw coded('组合框存在多个完全匹配的选项。','multiple_exact_options');
      if(all.some(({option})=>option.matches('[disabled]')||option.getAttribute('aria-disabled')==='true'))throw coded('完全匹配的组合框选项已禁用。','option_disabled');
      throw coded('组合框没有完全匹配的选项。','no_exact_option');
    }
    const {list,option}=matches[0],commitValue=option.getAttribute('data-value')||option.getAttribute('value');
    if(hidden.length&&(!commitValue||lists.some(candidateList=>Array.from(candidateList.querySelectorAll('[role=option]')).some(candidate=>candidate!==option&&!candidate.matches('[disabled]')&&candidate.getAttribute('aria-disabled')!=='true'&&(candidate.getAttribute('data-value')||candidate.getAttribute('value'))===commitValue)))){rollback();throw coded('组合框选项没有唯一的提交值。','page_rejected');}
    try{option.click();}catch{}
    await wait(30);
    const expanded=el.getAttribute('aria-expanded'),collapsed=expanded==='false'||(expanded===null&&list.getAttribute('aria-hidden')==='true');
    const selected=option.getAttribute('aria-selected')==='true';
    const displayed=normOption(read(el))===wanted;
    const committed=hidden.length===0||hidden.every(input=>input.value===commitValue&&commitValue!=='');
    if(!collapsed||!selected||!displayed||!committed){rollback();throw coded('组合框没有提交唯一完全匹配的选项。','page_rejected');}
    field.combo={hidden,hiddenBefore,submittedHidden:hidden.map(input=>input.value)};
  }
  async function tryWrite(field,value,wait){
    if(field.kind==='combobox'){await writeCombobox(field,value,wait);return true;}
    write(field.el,value);
    await wait(20);
    if(sameValue(field.el,value))return true;
    if(typeFallback(field.el,value)){await wait(20);if(sameValue(field.el,value))return true;}
    return false;
  }
  function sameCommitted(field){return !field.combo||field.combo.hidden.every((input,i)=>input.isConnected&&input.value===field.combo.submittedHidden?.[i]);}
  async function apply(s,values,wait=ms=>new Promise(r=>setTimeout(r,ms))){
    if(!fresh(s))throw coded('表单已变化，请重新聚焦该字段。','page_changed');
    const changes=[],failed=[],rejected=[],issues=[];const pageRejected=new Set();let error;
    const note=(id,code)=>{if(code&&!issues.some(i=>i.id===id&&i.code===code))issues.push({id,code});};
    for(const f of s.fields){
      const value=values[f.id];
      if(typeof value!=='string')continue;
      const textField=f.el.tagName==='INPUT'||f.el.tagName==='TEXTAREA';
      const over=textField&&Number.isInteger(f.el.maxLength)&&f.el.maxLength>=0&&value.length>f.el.maxLength;
      const under=textField&&Number.isInteger(f.el.minLength)&&f.el.minLength>0&&value.length<f.el.minLength;
      if(over||under){
        error=over?'内容超过字段最大长度。':'内容短于字段最小长度。';
        rejected.push(f.id);note(f.id,over?'answer_too_long':'answer_too_short');continue;
      }
      if(!f.el.isConnected||read(f.el)!==f.before){error='粘贴过程中表单发生了变化。';note(f.id,'page_changed');break;}
      const change={...f,after:value};changes.push(change);
      try{
        if(!await tryWrite(f,value,wait))failed.push(change);
        else if(f.kind==='combobox')change.combo={...f.combo};
      }catch(e){failed.push(change);error=e.message;if(e.code)change.writeCode=e.code;}
    }
    // Blur only when focus is restored, not after every field: many forms
    // validate/reformat/reset on blur.
    if(s.focus.isConnected)s.focus.focus();
    await wait(120);
    if(failed.length){
      // Retry only a field the page left empty; never overwrite a non-empty
      // value that the page or the user produced in the meantime.
      const retry=[],still=[];
      for(const c of failed){
        if(c.kind==='combobox'||!c.el.isConnected||read(c.el)!=='')still.push(c);
        else retry.push(c);
      }
      for(const c of retry){
        try{if(!await tryWrite(c,c.after,wait))still.push(c);}catch(e){if(e.code)c.writeCode=e.code;still.push(c);}
      }
      failed.length=0;failed.push(...still);
      if(s.focus.isConnected)s.focus.focus();
      await wait(120);
    }
    for(const c of changes){
      if(!c.el.isConnected)continue;
      const retained=sameValue(c.el,c.after)&&(c.kind!=='combobox'||sameCommitted(c));
      if(retained){
        if(!pageInvalid(c.el))continue;
        pageRejected.add(c.id);
        try{restoreChange(c,false);}catch{}
        note(c.id,'page_rejected');
        continue;
      }
      const empty=read(c.el)==='';
      const code=c.writeCode||(empty?'page_rejected':'page_changed');
      if(code==='page_rejected'&&empty&&String(c.before??'')!==''){
        try{restoreChange(c,false);}catch{}
      }
      note(c.id,code);
    }
    const reverted=changes.filter(c=>!sameValue(c.el,c.after)||(c.kind==='combobox'&&!sameCommitted(c)));
    const revertedSet=new Set(reverted);
    const failedIds=changes.filter(c=>revertedSet.has(c)||pageRejected.has(c.id)).map(c=>c.id);
    const verified=changes.length>0&&failedIds.length===0&&!error&&rejected.length===0&&pageRejected.size===0;
    const detail=pageRejected.size?'页面拒绝了粘贴的值。':reverted.length?`页面没有保留 ${reverted.length} 个字段。`:'页面没有保留所有字段。';
    return {changes,verified,failed:failedIds,reverted,rejected,issues,error:error||(rejected.length?`${rejected.length} 个字段因长度限制被拒绝。`:(!verified?detail+' 请检查表单，可使用撤销。':null))};
  }
  async function undo(changes,wait=ms=>new Promise(r=>setTimeout(r,ms))){
    const restored=[];
    for(const change of changes){
      if(!change.el.isConnected||!sameValue(change.el,change.after)||(change.kind==='combobox'&&!sameCommitted(change)))continue;
      if(change.kind==='combobox'){
        setInputValue(change.el,String(change.before??''));
        restoreHidden(change.combo.hidden,change.combo.hiddenBefore);
        dispatch(change.el,'change',{bubbles:true,composed:true});
      }else{restoreValue(change.el,change.before);change.el.blur();}
      restored.push(change);
    }
    await wait(120);
    return restored.filter(change=>change.el.isConnected&&sameValue(change.el,change.before)&&(change.kind!=='combobox'||change.combo.hidden.every((input,i)=>input.isConnected&&input.value===(change.combo.hiddenBefore[i]??'')))).length;
  }
  root.SmartPasteAdapters={read,label,kind,supported,snapshot,context,fresh,write,apply,undo,normalizeOption};if(typeof module!=='undefined')module.exports=root.SmartPasteAdapters;
})(globalThis);
