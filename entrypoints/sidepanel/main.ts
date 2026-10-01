import { browser } from 'wxt/browser';
import type { Action, Profile, Rule, Snapshot } from '../../src/contracts';
import { fingerprint, originFor, ruleKey } from '../../src/contracts';
import { request, snapshot } from '../../src/bridge';
import { createSystemPrompt, toolSchemas, DEFAULT_INSTRUCTIONS } from '../../src/system-prompt.ts';
import './style.css';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const profilesEl = $('#profiles'), toolsEl = $('#tools'), promptsEl = $('#prompts'), resultsEl = $('#results');
const form = $('#profile-form') as HTMLFormElement;
let state: Snapshot | undefined;
let refreshing = false;
let editingProfile: string | undefined;
const argumentDrafts: Record<string, string> = {};
const promptDrafts: Record<string, Record<string, string>> = {};
const promptEditor = $('#prompt-editor') as HTMLTextAreaElement;
let promptEditorDirty = false;
promptEditor.addEventListener('input', () => { promptEditorDirty = true; });

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
function selectTab(tab: HTMLButtonElement, focus = false) {
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    $(`#${candidate.getAttribute('aria-controls')}`).hidden = !selected;
  }
  $('#page-title').textContent = tab.id.slice(4).replace(/^./, letter => letter.toUpperCase());
  if (focus) tab.focus();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next: number;
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % tabs.length; break;
      case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break;
      case 'Home': next = 0; break;
      case 'End': next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault(); selectTab(tabs[next], true);
  });
}

function showError(error: unknown) {
  const box = $('#error'); box.hidden = false;
  box.textContent = error instanceof Error ? error.message : String(error);
}
async function act(action: Action): Promise<boolean> {
  $('#error').hidden = true;
  try { await request(action); await refresh(); return true; }
  catch (error) { showError(error); return false; }
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node;
}
function button(label: string, handler: () => void, cls = 'quiet') {
  const b = element('button', label, cls); b.type = 'button'; b.addEventListener('click', handler); return b;
}
function renderProfiles(s: Snapshot) {
  profilesEl.replaceChildren();
  if (!s.profiles.length) profilesEl.append(element('p', 'No profiles yet. Add a server to get started.', 'muted'));
  for (const profile of s.profiles) {
    const connection = s.connections[profile.name];
    const card = element('article', undefined, 'profile-card');
    const heading = element('div', undefined, 'profile-heading');
    const identity = element('div'); identity.append(element('strong', profile.name), element('small', profile.url));
    const status = element('span', connection?.status ?? 'disconnected', `status ${connection?.status === 'connected' ? 'online' : ''}`);
    heading.append(identity, status); card.append(heading);
    const controls = element('div', undefined, 'actions');
    controls.append(button(connection?.status === 'connected' ? 'Disconnect' : 'Connect', () => void connect(profile, connection?.status === 'connected'), connection?.status === 'connected' ? 'quiet' : 'primary'));
    const edit = button('Edit', () => {
      editingProfile = profile.name;
      for (const key of ['name', 'url', 'transport'] as const) (form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement).value = profile[key];
      form.hidden = false; (form.elements.namedItem('name') as HTMLInputElement).focus();
    });
    edit.disabled = connection?.status === 'connected';
    edit.title = edit.disabled ? 'Disconnect before editing profile' : 'Edit profile';
    controls.append(edit);
    controls.append(button('Remove', () => void act({ type: 'remove', name: profile.name }), 'danger-quiet'));
    card.append(controls);
    if (connection?.error) card.append(element('p', connection.error, 'inline-error'));
    profilesEl.append(card);
  }
}
async function connect(profile: Profile, disconnect: boolean) {
  $('#error').hidden = true;
  try {
    if (disconnect) await request({ type: 'disconnect', name: profile.name });
    else {
      const url = new URL(profile.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Use an HTTP, HTTPS, WS, or WSS endpoint.');
      const allowed = await browser.permissions.request({ origins: [originFor(profile.url)] });
      if (!allowed) throw new Error(`Host permission was not granted for ${url.origin}.`);
      await request({ type: 'connect', name: profile.name });
    }
    await refresh();
  } catch (error) { showError(error); }
}
function renderTools(s: Snapshot) {
  toolsEl.replaceChildren();
  const rows = s.profiles.flatMap(profile => (s.connections[profile.name]?.tools ?? []).map(tool => ({ profile, tool })));
  if (!rows.length) { toolsEl.append(element('p', 'Connect a server to discover its tools.', 'muted')); return; }
  for (const { profile, tool } of rows) {
    const rule = s.rules[ruleKey(profile.name, tool.name)];
    const card = element('article', undefined, 'tool-card');
    const title = element('div', undefined, 'tool-title'); title.append(element('strong', tool.name), element('span', profile.name, 'tag'));
    card.append(title); if (tool.description) card.append(element('p', tool.description, 'muted'));
    const review = element('details', undefined, 'review'); const summary = element('summary', rule ? 'Review classifications' : 'Review this tool before trusting it'); summary.setAttribute('aria-label', `Review classifications for ${tool.name}`); review.append(summary);
    const checkboxes: Record<keyof Omit<Rule, 'fingerprint'>, HTMLInputElement> = { readOnly: checkbox('Read-only'), consequential: checkbox('Consequential'), sensitive: checkbox('Sensitive output') };
    checkboxes.readOnly.checked = rule?.readOnly ?? false; checkboxes.consequential.checked = rule?.consequential ?? false; checkboxes.sensitive.checked = rule?.sensitive ?? false;
    for (const input of Object.values(checkboxes)) review.append(input.parentElement!);
    review.append(button('Save review', () => void act({ type: 'rule', server: profile.name, tool: tool.name, rule: { readOnly: checkboxes.readOnly.checked, consequential: checkboxes.consequential.checked, sensitive: checkboxes.sensitive.checked } }), 'small-button'));
    if (rule && rule.fingerprint !== fingerprint(tool)) review.append(element('p', 'Tool metadata changed; review again before relying on this classification.', 'inline-error'));
    card.append(review);
    const schema = element('details', undefined, 'schema'); schema.append(element('summary', 'Arguments schema')); const schemaPre = element('pre'); schemaPre.textContent = JSON.stringify(tool.inputSchema, null, 2); schema.append(schemaPre); card.append(schema);
    const editor = element('details', undefined, 'invoke'); editor.open = true; editor.append(element('summary', 'Invoke tool'));
    const draftKey = JSON.stringify([profile.name, tool.name]);
    const textarea = element('textarea'); textarea.rows = 3; textarea.setAttribute('aria-label', `${tool.name} JSON arguments`); textarea.value = argumentDrafts[draftKey] ?? '{}'; textarea.spellcheck = false;
    textarea.addEventListener('input', () => { argumentDrafts[draftKey] = textarea.value; });
    editor.append(textarea, button('Run tool', () => {
      let args: unknown;
      try { args = JSON.parse(textarea.value); if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Arguments must be a JSON object.'); }
      catch (error) { showError(error); return; }
      void act({ type: 'invoke', command: { id: crypto.randomUUID(), server: profile.name, tool: tool.name, arguments: args as Record<string, unknown> } });
    }, 'primary'));
    card.append(editor); toolsEl.append(card);
  }
}
function checkbox(label: string): HTMLInputElement {
  const wrap = element('label', undefined, 'check-row'); const input = element('input'); input.type = 'checkbox'; wrap.append(input, document.createTextNode(label)); return input;
}
function renderPrompts(s: Snapshot) {
  const live = new Set(s.prompts.map(prompt => prompt.id));
  for (const id of Object.keys(promptDrafts)) if (!live.has(id)) delete promptDrafts[id];
  promptsEl.replaceChildren();
  if (!s.prompts.length) { promptsEl.append(element('p', 'No pending prompts.', 'muted')); return; }
  for (const prompt of s.prompts) {
    const card = element('article', undefined, 'prompt-card'); card.append(element('p', prompt.message, 'prompt-message'));
    if (prompt.kind === 'elicitation') {
      const schema = prompt.schema ?? {}; const properties = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, Record<string, unknown>>;
      const content: Record<string, unknown> = {}; const fields: Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = {};
      if (Object.keys(properties).length === 1 && properties.approved_path?.const !== undefined) {
        const path=element('pre',String(properties.approved_path.const));
        card.append(path,button('Approve',()=>void act({type:'reply',id:prompt.id,action:'accept',content:{approved_path:properties.approved_path.const}}),'primary'),button('Deny',()=>void act({type:'reply',id:prompt.id,action:'decline'}),'quiet'));
        promptsEl.append(card);continue;
      }
      for (const [key, spec] of Object.entries(properties)) {
        const label = element('label', `${key}${Array.isArray(schema.required) && schema.required.includes(key) ? ' *' : ''}`, 'form-field');
        const control = spec.enum ? element('select') : (spec.type === 'boolean' ? element('select') : element('input'));
        if (control instanceof HTMLSelectElement) {
          const choices = spec.enum ? ['', ...spec.enum.map(String)] : ['', 'true', 'false'];
          for (const value of choices) { const option = element('option', value || 'Choose…'); option.value = value; control.append(option); }
        } else if (spec.type === 'object' || spec.type === 'array') { const area = element('textarea'); area.rows = 2; const initial=spec.const !== undefined ? spec.const : spec.default; area.value = promptDrafts[prompt.id]?.[key] ?? (initial !== undefined ? JSON.stringify(initial) : ''); area.addEventListener('input', () => { (promptDrafts[prompt.id] ??= {})[key] = area.value; }); fields[key] = area; label.append(area); card.append(label); continue; }
        else if (spec.type === 'string' && spec.format === 'uri') control.type = 'url';
        const initial = spec.const !== undefined ? spec.const : spec.default;
        const draft = promptDrafts[prompt.id]?.[key];
        if (draft !== undefined) control.value = draft;
        else if (initial !== undefined) control.value = String(initial);
        control.setAttribute('aria-label', key); fields[key] = control;
        control.addEventListener('input', () => { (promptDrafts[prompt.id] ??= {})[key] = control.value; });
        label.append(control); card.append(label);
      }
      if (prompt.schema) { const schemaDetails = element('details'); schemaDetails.append(element('summary', 'Requested data schema')); const pre = element('pre'); pre.textContent = JSON.stringify(prompt.schema, null, 2); schemaDetails.append(pre); card.append(schemaDetails); }
      const collect = () => {
        for (const [key, control] of Object.entries(fields)) {
          if (!control.value) {
            if (Array.isArray(schema.required) && schema.required.includes(key)) throw new Error(`${key} is required.`);
            continue;
          }
          const spec = properties[key]; let value: unknown = control.value;
          if (spec.type === 'boolean') value = control.value === 'true';
          else if (spec.type === 'number' || spec.type === 'integer') { value = Number(control.value); if (!Number.isFinite(value)) throw new Error(`${key} must be a number.`); }
          else if (spec.type === 'object' || spec.type === 'array') { try { value = JSON.parse(control.value); } catch { throw new Error(`${key} must contain valid JSON.`); } }
          content[key] = value;
        }
        return content;
      };
      card.append(button('Accept and send reply', () => { try { void act({ type: 'reply', id: prompt.id, action: 'accept', content: collect() }); } catch (error) { showError(error); } }, 'primary'), button('Decline', () => void act({ type: 'reply', id: prompt.id, action: 'decline' }), 'quiet'));
    } else {
      card.append(element('p', prompt.kind === 'disclosure' ? 'Review exactly what will be shared before accepting.' : 'Review the requested tool execution before accepting.', 'hint'));
      card.append(button('Accept', () => void act({ type: 'reply', id: prompt.id, action: 'accept' }), 'primary'), button('Decline', () => void act({ type: 'reply', id: prompt.id, action: 'decline' }), 'quiet'));
    }
    card.append(button('Cancel', () => void act({ type: 'reply', id: prompt.id, action: 'cancel' }), 'danger-quiet'));
    promptsEl.append(card);
  }
}
function renderResults(s: Snapshot) {
  resultsEl.replaceChildren(); const rows = Object.entries(s.results).reverse();
  if (!rows.length) { resultsEl.append(element('p', 'No completed tool calls.', 'muted')); return; }
  for (const [id, result] of rows) { const card = element('article', undefined, 'result-card'); card.append(element('strong', id)); const pre = element('pre'); pre.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2); card.append(pre); resultsEl.append(card); }
}
function render(s: Snapshot) {
  const previous = state;
  state = s;
  const active = document.activeElement;
  if (JSON.stringify([previous?.profiles, previous?.connections]) !== JSON.stringify([s.profiles, s.connections])) renderProfiles(s);
  if ((!active || !toolsEl.contains(active)) && JSON.stringify([previous?.connections, previous?.rules]) !== JSON.stringify([s.connections, s.rules])) renderTools(s);
  if (JSON.stringify([previous?.connections, previous?.customPrompt]) !== JSON.stringify([s.connections, s.customPrompt])) {
    $('#system-prompt').textContent = createSystemPrompt(s);
    if (!promptEditorDirty) promptEditor.value = s.customPrompt ?? DEFAULT_INSTRUCTIONS;
  }
  if (JSON.stringify(previous?.prompts) !== JSON.stringify(s.prompts)) renderPrompts(s);
  if (JSON.stringify(previous?.results) !== JSON.stringify(s.results)) renderResults(s);
  const connected = Object.values(s.connections).filter(c => c.status === 'connected').length;
  $('#connection-count').textContent = `${connected} connected`;
  const badge = $('#pending-count');
  badge.hidden = s.prompts.length === 0;
  badge.textContent = String(s.prompts.length);
  $('#tab-activity').setAttribute('aria-label', s.prompts.length ? `Activity, ${s.prompts.length} pending approvals` : 'Activity');
  const preset = $('#preset') as HTMLSelectElement; if (active !== preset) preset.value = s.preset;
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try { render(await snapshot()); }
  catch (error) { if (!state) showError(error); }
  finally { refreshing = false; }
}
$('#new-profile').addEventListener('click', () => { editingProfile = undefined; form.reset(); form.hidden = false; (form.elements.namedItem('name') as HTMLInputElement).focus(); });
$('#cancel-profile').addEventListener('click', () => { editingProfile = undefined; form.reset(); form.hidden = true; });
form.addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(form);
  const profile = { name: String(data.get('name')).trim(), url: String(data.get('url')).trim(), transport: String(data.get('transport')) as Profile['transport'] };
  if (!profile.name || !profile.url) return;
  if (state?.profiles.some(saved => saved.name === profile.name && saved.name !== editingProfile)) { showError('Profile name already exists'); return; }
  try { const url = new URL(profile.url); if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Use an HTTP, HTTPS, WS, or WSS URL.'); }
  catch (error) { showError(error); return; }
  void act({ type: 'save', profile, originalName: editingProfile }).then(saved => { if (saved) { editingProfile = undefined; form.reset(); form.hidden = true; } });
});
$('#preset').addEventListener('change', event => void act({ type: 'preset', preset: (event.currentTarget as HTMLSelectElement).value as Snapshot['preset'] }));
async function copyText(text: string, label: string) {
  const status = $('#system-prompt-copy-state');
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = label;
  } catch {
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', '');
    area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    const copied = document.execCommand('copy');
    area.remove();
    status.textContent = copied ? label : '';
    if (!copied) showError(new Error('Clipboard unavailable in this panel'));
  }
}
$('#copy-system-prompt').addEventListener('click', () => { void copyText($('#system-prompt').textContent ?? '', 'Copied'); });
$('#copy-tool-schemas').addEventListener('click', () => { if (state) void copyText(toolSchemas(state), 'Copied tool schemas'); });
$('#save-prompt').addEventListener('click', async () => {
  const saved = await act({ type: 'custom-prompt', text: promptEditor.value.trim() || undefined });
  if (saved) promptEditorDirty = false;
});
$('#reset-prompt').addEventListener('click', async () => {
  promptEditor.value = DEFAULT_INSTRUCTIONS;
  const saved = await act({ type: 'custom-prompt' });
  if (saved) promptEditorDirty = false;
});
$('#deepseek').addEventListener('click', async () => {
  $('#error').hidden = true;
  try {
    const granted = await browser.permissions.request({ origins: ['https://chat.deepseek.com/*'] });
    if (!granted) throw new Error('DeepSeek site access was not granted.');
    $('#deepseek-state').textContent = 'Access granted';
  } catch (error) { showError(error); }
});
void refresh(); window.setInterval(() => void refresh(), 1200);
