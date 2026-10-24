(async()=>{
 const app=SmartPasteUI.mountSettings(document.getElementById('app')),$=id=>app.querySelector('#'+id),save=app.querySelector('.sp-save');
 const clearError=()=>{['gateway','token'].forEach(id=>{$(id).removeAttribute('aria-invalid');const e=$(id+'-error');e.hidden=true;e.textContent='';});};
 const fail=(id,msg)=>{$(id).setAttribute('aria-invalid','true');const e=$(id+'-error');e.textContent=msg;e.hidden=false;};
 $('gateway').addEventListener('input',clearError);$('token').addEventListener('input',clearError);$('consent').addEventListener('change',clearError);
 save.disabled=true;
 try{const s=await chrome.storage.local.get({gateway:'https://cee.songm.dpdns.org',token:'',consent:true});$('gateway').value=s.gateway;$('token').value=s.token;$('consent').checked=s.consent;$('connection').textContent=s.token&&s.gateway?'Token saved':'Not configured';}
 catch{$('status').textContent='Couldn’t load settings. Reload this page.';return;}
 save.disabled=false;
 $('shortcut').onclick=()=>chrome.tabs.create({url:'chrome://extensions/shortcuts'});
 $('settings').onsubmit=async e=>{
  e.preventDefault();if(save.disabled)return;clearError();
  const gateway=$('gateway').value.trim().replace(/\/+$/,''),token=$('token').value.trim(),consent=$('consent').checked;
  if(consent&&!gateway){fail('gateway','Add the cee gateway URL to enable matching.');$('status').textContent='Add the cee gateway URL.';$('gateway').focus();return;}
  save.disabled=true;save.textContent='Saving…';$('settings').setAttribute('aria-busy','true');
  try{await chrome.storage.local.set({gateway,token,consent});$('connection').textContent=token&&gateway?'Token saved':'Not configured';$('status').textContent='Changes saved.';}
  catch{$('status').textContent='Couldn’t save. Try again.';}
  finally{save.disabled=false;save.textContent='Save changes';$('settings').removeAttribute('aria-busy');}
 };
})();
