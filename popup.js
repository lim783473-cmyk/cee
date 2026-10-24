const app=SmartPasteUI.mountCapture(document.getElementById('app')),q=s=>app.querySelector(s);
const status=q('#capture-status'),preview=q('#capture');
let capturing=false;
function display(text=''){preview.textContent=text;q('#capture-details').hidden=!text;q('#capture-details').open=false;q('#clear').disabled=!text;}
async function capture(){
 if(capturing)return;capturing=true;
 q('#read').disabled=true;q('#clear').disabled=true;status.textContent='正在读取剪贴板…';
 try{const text=await navigator.clipboard.readText();const r=await chrome.runtime.sendMessage({type:'capture',text});if(r.error)throw Error(r.error);display(text);status.textContent='已捕获。聚焦支持的字段即可填入。';}
 catch(e){display();status.textContent=e.message||'无法读取剪贴板，请重试。';}
 finally{capturing=false;q('#read').disabled=false;}
}
q('#read').onclick=capture;
q('#clear').onclick=async()=>{try{const r=await chrome.runtime.sendMessage({type:'clear'});if(r.error)throw Error(r.error);display();status.textContent='已清除捕获，复制文字后可重新开始。';}catch{status.textContent='无法清除捕获，请重试。';}};
q('#capture-settings').onclick=()=>chrome.runtime.openOptionsPage();
capture();
