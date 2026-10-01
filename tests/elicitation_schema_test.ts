import { prefillElicitationSchema } from '../src/elicitation-schema.ts';
Deno.test('workspace confirmation fixes only recognized server canonical paths',()=>{
  const schema={type:'object',properties:{approved_path:{type:'string'}},required:['approved_path']};
  const path='S:\\Data\\CODE\\Rust';
  const message=`Allow this server to switch its workspace to '${path}'? This changes the directory used by read, write, edit, list, grep, and trusted exec when exec is enabled.`;
  const result=prefillElicitationSchema(message,schema) as {properties:{approved_path:{const:string}}};
  if(result.properties.approved_path.const!==path)throw new Error('Canonical path not preserved');
  if(prefillElicitationSchema('Please approve another path',schema)!==schema)throw new Error('Unrecognized message supplied approval value');
  const explicit={properties:{approved_path:{type:'string',const:'server-value'}}};
  if(prefillElicitationSchema(message,explicit)!==explicit)throw new Error('Server constant overwritten');
});
