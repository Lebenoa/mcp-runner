import { createPayloadSection } from './payload-view.ts';
export function createBlockCard(doc: Document, metadata: {id:string;server:string;tool:string}, status: string, sections: Record<string, unknown>, raw: string): HTMLDetailsElement {
  const card=doc.createElement('details');card.className='mcp-card';
  const summary=doc.createElement('summary');summary.className='mcp-card-header';
  const icon=doc.createElement('span');icon.className='mcp-card-icon';icon.setAttribute('aria-hidden','true');
  const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','18');svg.setAttribute('height','18');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.5');
  const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4');svg.append(path);icon.append(svg);
  const identity=doc.createElement('span');identity.className='mcp-card-identity';
  const title=doc.createElement('strong');title.textContent=`${metadata.server} / ${metadata.tool}`;
  const id=doc.createElement('small');id.textContent=metadata.id;identity.append(title,id);
  const badge=doc.createElement('span');badge.className='mcp-card-status';badge.textContent=status;
  summary.append(icon,identity,badge);card.append(summary);
  const body=doc.createElement('div');body.className='mcp-card-body';
  for(const [label,value] of Object.entries(sections)) body.append(createPayloadSection(doc,label,value));
  const copy=doc.createElement('button');copy.type='button';copy.textContent='Copy original block';
  copy.addEventListener('click',()=>{void doc.defaultView?.navigator.clipboard.writeText(raw).then(()=>{copy.textContent='Copied';},()=>{copy.textContent='Copy unavailable';});});
  body.append(copy);card.append(body);return card;
}
