function node(doc: Document, tag: string, text?: string, className?: string): HTMLElement {
  const element = doc.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

// Pathological server payloads must not overflow the stack; deeper levels
// collapse to a marker. The lazy toggle defers rendering, not the bound.
const MAX_DEPTH = 20;

function jsonValue(doc: Document, value: unknown, depth = 0): HTMLElement {
  if (value !== null && typeof value === 'object') {
    if (depth > MAX_DEPTH) return node(doc, 'span', '… too deep to render', 'mcp-value');
    const array = Array.isArray(value);
    const entries = Object.entries(value);
    if (!entries.length) return node(doc, 'span', array ? '[] · empty array' : '{} · empty object', 'mcp-value mcp-empty');
    const details = doc.createElement('details'); details.className = 'mcp-json-group'; details.open = depth < 2;
    details.append(node(doc, 'summary', `${array ? 'Array' : 'Object'} · ${entries.length} ${array ? 'items' : 'fields'}`));
    const rows = node(doc, 'dl', undefined, 'mcp-json-rows');
    const populate = () => {
      if (rows.childElementCount) return;
      for (const [key, item] of entries) {
        const row = node(doc, 'div', undefined, 'mcp-json-row');
        const field = node(doc, 'dd'); field.append(jsonValue(doc, item, depth + 1));
        row.append(node(doc, 'dt', array ? `[${key}]` : key), field); rows.append(row);
      }
    };
    details.addEventListener('toggle', () => { if (details.open) populate(); });
    if (details.open) populate();
    details.append(rows); return details;
  }
  const type = value === null ? 'null' : typeof value;
  return node(doc, 'span', typeof value === 'string' ? (value === '' ? '"" · empty string' : value) : String(value), `mcp-value mcp-${type}`);
}

function textContent(doc: Document, text: string): HTMLElement {
  try { return jsonValue(doc, JSON.parse(text)); }
  catch { return node(doc, 'div', text, 'mcp-response-text'); }
}

export function createPayloadSection(doc: Document, label: string, value: unknown): HTMLElement {
  const response = label === 'Result' || label === 'Response';
  const section = node(doc, 'section', undefined, 'mcp-payload');
  section.append(node(doc, 'h4', response ? 'Response' : label === 'Arguments' ? 'Request' : label));
  const surface = node(doc, 'div', undefined, 'mcp-payload-surface');
  if (response && value && typeof value === 'object' && !Array.isArray(value)) {
    const payload = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(payload)) {
      const part = node(doc, 'section', undefined, 'mcp-response-part');
      part.append(node(doc, 'h5', key === 'structuredContent' ? 'Structured content' : key === 'content' ? 'Content' : key));
      if (key === 'content' && Array.isArray(item)) {
        item.forEach((block, index) => {
          const entry = node(doc, 'div', undefined, 'mcp-content-entry');
          entry.append(node(doc, 'small', `Content ${index + 1}`));
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            entry.append(textContent(doc, block.text));
            const extra = Object.fromEntries(Object.entries(block).filter(([field]) => field !== 'text' && field !== 'type'));
            if (Object.keys(extra).length) entry.append(jsonValue(doc, extra));
          } else entry.append(jsonValue(doc, block));
          part.append(entry);
        });
        if (!item.length) part.append(jsonValue(doc, item));
      } else part.append(jsonValue(doc, item));
      surface.append(part);
    }
    if (!Object.keys(payload).length) surface.append(jsonValue(doc, payload));
  } else surface.append(response && typeof value === 'string' ? textContent(doc, value) : jsonValue(doc, value));
  const raw = doc.createElement('details'); raw.className = 'mcp-raw-json';
  raw.append(node(doc, 'summary', 'Raw JSON'), node(doc, 'pre', JSON.stringify(value, null, 2)));
  section.append(surface, raw); return section;
}
