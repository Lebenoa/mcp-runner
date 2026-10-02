import { chromium } from '@playwright/test';
import { startServer } from './server.ts';
Deno.test({name:'built ChatGPT adapter: verified selectors drive real tool execution',sanitizeOps:false,sanitizeResources:false,fn:async()=>{
  // Fixture mirrors the VERIFIED live chatgpt.com DOM (2026-10): a hidden
  // shadow textarea that must lose to the visible ProseMirror composer, the
  // #composer-submit-button send control, and code blocks whose language is a
  // sticky header inside the <pre> with the body in an inner <code>, plus a
  // nested CodeMirror-style duplicate pre that must be ignored.
  const fixture=startServer();
  const serverName=`http-${Date.now()}`;
  // A persistent profile keeps granted permissions across runs; a fresh
  // profile would need a new OS-level Allow every time.
  const profile=`${Deno.cwd()}/.output/chatgpt-e2e-profile`;
  const context=await chromium.launchPersistentContext(profile,{headless:false,channel:'chromium',args:[`--disable-extensions-except=${Deno.cwd()}/.output/chrome-mv3`,`--load-extension=${Deno.cwd()}/.output/chrome-mv3`]});
  try{
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
    const panel=await context.newPage();await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.getByText('0 connected',{exact:true}).waitFor();
    // The persistent profile may contain profiles from earlier runs.
    await panel.click('#new-profile');await panel.locator('[name="name"]').fill(serverName);
    await panel.locator('[name="url"]').fill(fixture.url+'/mcp');
    await panel.getByRole('button',{name:'Save profile',exact:true}).click();
    // Chrome dismisses permission prompts from unfocused windows; retry until
    // the OS-level Allow lands (or the prompt is auto-granted).
    let connected=false;
    for(let attempt=0;attempt<12&&!connected;attempt++){
      await panel.bringToFront();
      await panel.locator('.profile-card').filter({has:panel.locator('strong').getByText(serverName,{exact:true})}).getByRole('button',{name:'Connect',exact:true}).click();
      try{await panel.locator('.profile-card').getByText('connected',{exact:true}).waitFor({timeout:8000});connected=true;}
      catch{await panel.waitForTimeout(1500);}
    }
    if(!connected)throw new Error('Connect did not succeed (click Allow on the permission prompt if it appears)');
    await panel.click('#tab-settings');
    await panel.locator('#preset').selectOption('yolo');
    // Granting site access registers the chatgpt content script dynamically.
    for(let attempt=0;attempt<4;attempt++){
      await panel.getByRole('button',{name:'Enable ChatGPT access'}).click();
      try{await panel.locator('#chatgpt-state').getByText('Access granted',{exact:true}).waitFor({timeout:5000});break;}
      catch{await panel.waitForTimeout(1000);}
    }
    await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><main><div id="messages"></div></main><form><textarea name="prompt-textarea" aria-label="Chat with ChatGPT" hidden></textarea><div id="prompt-textarea" contenteditable="true" aria-label="Chat with ChatGPT"></div><button type="submit" id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" disabled></button></form><script>
window.sent=[];
const composer=document.querySelector('#prompt-textarea');
const send=document.querySelector('#composer-submit-button');
const sync=()=>{send.disabled=!composer.textContent.trim();};
composer.addEventListener('input',sync);sync();
function submit(){const text=composer.textContent;if(!text.trim())return;window.sent.push(text);composer.textContent='';sync();
  // chatgpt.com renders user messages as markdown: fences become pre>code
  // and the backticks vanish from the DOM text.
  const message=document.createElement('div');message.setAttribute('data-message-author-role','user');
  const content=document.createElement('div');
  const fence=String.fromCharCode(96).repeat(3);
  const start=text.indexOf(fence);
  if(start>=0){const langEnd=text.indexOf('\\n',start);const end=text.indexOf(fence,langEnd);
    // The real site keeps the language line inside the code text.
    if(langEnd>=0&&end>=0){const pre=document.createElement('pre');const code=document.createElement('code');code.textContent=text.slice(start+3,langEnd)+'\\n'+text.slice(langEnd+1,end);pre.append(code);content.append(pre);}
    else content.textContent=text;}
  else content.textContent=text;
  message.append(content);document.querySelector('#messages').append(message);
  setTimeout(()=>renderAssistant(JSON.stringify({id:'gpt-echo-${serverName}',server:'${serverName}',tool:'echo',arguments:{value:'gpt-ran'}})),200);}
send.addEventListener('click',submit);
composer.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit();}});
window.renderAssistant=function(text){
  const message=document.createElement('div');message.setAttribute('data-message-author-role','assistant');
  const content=document.createElement('div');
  const pre=document.createElement('pre');
  const wrap=document.createElement('div');
  const header=document.createElement('div');header.className='select-none sticky z-2';header.textContent='mcp';
  const code=document.createElement('code');code.textContent=text;
  wrap.append(header,code);
  const mirror=document.createElement('pre');mirror.className='cm-content readonly';mirror.textContent=text;
  wrap.append(mirror);
  pre.append(wrap);content.append(pre);message.append(content);
  document.querySelector('#messages').append(message);
};
</script></body></html>`}));
    const chat=await context.newPage();await chat.goto('https://chatgpt.com/');
    await chat.locator('#prompt-textarea').fill('Inspect my workspace');
    await chat.locator('#prompt-textarea').press('Enter');
    await chat.waitForFunction(()=> 'sent' in window && Array.isArray(window.sent) && window.sent.length===1);
    const firstSent=await chat.evaluate(()=>(window as unknown as {sent:string[]}).sent[0]);
    // A contenteditable composer does not preserve newlines in textContent.
    const flat=firstSent.replace(/\s+/g,' ').trim();
    if(!flat.endsWith('User request: Inspect my workspace'))throw new Error('First user request not preserved');
    const listed=JSON.parse(flat.split('Available tools from currently connected servers:')[1].split('User request:')[0].trim());
    if(!(Array.isArray(listed)&&listed.length===1&&listed[0].server===serverName))throw new Error('Missing connected tool listing');
    // The assistant reply contains a real command in the verified block
    // structure; the built extension must detect, invoke and submit the result.
    await chat.waitForFunction(()=> (window as unknown as {sent:string[]}).sent.length===2,{timeout:15000});
    const resultSent=await chat.evaluate(()=>(window as unknown as {sent:string[]}).sent[1]);
    const result=JSON.parse(resultSent.match(/```mcp-result\n([\s\S]*?)\n```/)![1]);
    if(!result.id.startsWith('gpt-echo')||result.server!==serverName||result.tool!=='echo')throw new Error('Result not correlated');
    if(!JSON.stringify(result.result).includes('gpt-ran'))throw new Error('Tool did not actually execute');
    // The submitted result must be re-carded from the markdown-rendered form.
    const userCard=chat.locator('[data-mcp-user-block]').filter({hasText:'gpt-echo'});
    await userCard.waitFor({state:'visible',timeout:15000});
    await userCard.locator('.mcp-card-header').click();
    await userCard.locator('.mcp-payload-surface').getByText('gpt-ran',{exact:true}).first().waitFor();
    console.log('Browser proof: ChatGPT adapter executed a real tool through the built extension');
    await chat.screenshot({path:'.output/chatgpt-proof.png'});
  }catch(error){for(const page of context.pages())console.log('Failure surface',page.url(),await page.locator('body').innerText());throw error;}finally{await context.close();await fixture.close();}
}});
