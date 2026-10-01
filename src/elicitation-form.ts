export function createElicitationForm(doc: Document, schema: Record<string, unknown> | undefined, reply: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => Promise<void>): HTMLElement {
  const form = doc.createElement('form'); form.className = 'mcp-elicitation';
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const fields = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const fixed = Object.entries(properties).length === 1 && properties.approved_path?.const !== undefined;
  if (fixed) {
    const path=doc.createElement('pre');path.textContent=String(properties.approved_path.const);form.append(path);
    for(const [text,action] of [['Approve','accept'],['Deny','decline']] as const){const button=doc.createElement('button');button.type='button';button.textContent=text;button.addEventListener('click',event=>{if(!event.isTrusted)return;button.disabled=true;void reply(action,action==='accept'?{approved_path:properties.approved_path.const}:undefined).catch(()=>{button.disabled=false;});});form.append(button);}
    return form;
  }
  for (const [key, spec] of Object.entries(properties)) {
    const label = doc.createElement('label'); label.textContent = String(spec.title ?? key);
    const input = spec.type === 'boolean' || Array.isArray(spec.enum) ? doc.createElement('select') : doc.createElement('input');
    input.setAttribute('aria-label', key);
    input.required = Array.isArray(schema?.required) && schema.required.includes(key);
    if (input instanceof doc.defaultView!.HTMLSelectElement) {
      for (const value of ['', ...(Array.isArray(spec.enum) ? spec.enum.map(String) : ['true','false'])]) { const option=doc.createElement('option');option.value=value;option.textContent=value || 'Choose…';input.append(option); }
    }
    const initial = spec.const !== undefined ? spec.const : spec.default;
    if (initial !== undefined) input.value = typeof initial === 'object' ? JSON.stringify(initial) : String(initial);
    label.append(input); if (spec.description) { const hint=doc.createElement('small');hint.textContent=String(spec.description);label.append(hint); }
    form.append(label);fields.set(key,input);
  }
  const error=doc.createElement('p');error.setAttribute('role','alert');form.append(error);
  const send=async(action:'accept'|'decline'|'cancel')=>{
    const content:Record<string,unknown>={};
    try {
      if(action==='accept')for(const [key,input] of fields){
        if(!input.value)continue;
        const raw=properties[key];
        const spec=(raw&&typeof raw==='object'?raw:{}) as Record<string, unknown>;
        if(spec.type==='boolean')content[key]=input.value==='true';
        else if(spec.type==='number'||spec.type==='integer'){const value=Number(input.value);if(!Number.isFinite(value))throw new Error(`${key} must be a number.`);content[key]=value;}
        else if(spec.type==='object'||spec.type==='array'){try{content[key]=JSON.parse(input.value);}catch{throw new Error(`${key} must contain valid JSON.`);}}
        else content[key]=input.value;
      }
      await reply(action,action==='accept'?content:undefined);
    } catch(failure){error.textContent=String(failure);}
  };
  form.addEventListener('submit',event=>{event.preventDefault();if(event.isTrusted)void send('accept');});
  for(const [text,action] of [['Approve and send reply','accept'],['Decline','decline'],['Cancel','cancel']] as const){const button=doc.createElement('button');button.textContent=text;button.type=action==='accept'?'submit':'button';if(action!=='accept')button.addEventListener('click',event=>{if(event.isTrusted)void send(action);});form.append(button);}
  return form;
}
