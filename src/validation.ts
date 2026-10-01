import { z } from 'zod';
const command = z.object({id:z.string().min(1),server:z.string().min(1),tool:z.string().min(1),arguments:z.record(z.unknown())}).strict();
export const actionSchema = z.discriminatedUnion('type',[
 z.object({type:z.literal('snapshot')}),
 z.object({type:z.literal('server-status'),id:z.string().trim().min(1),chat:z.string().url(),action:z.enum(['connect','disconnect']).optional(),server:z.string().min(1).optional()}),
 z.object({type:z.literal('save'),originalName:z.string().optional(),profile:z.object({name:z.string().trim().min(1),url:z.string().url(),transport:z.enum(['http','sse','ws'])})}),
 z.object({type:z.literal('remove'),name:z.string()}),
 z.object({type:z.literal('preset'),preset:z.enum(['auto-safe','ask','server-perms','yolo'])}),
 z.object({type:z.literal('custom-prompt'),text:z.string().max(20000).optional()}),
 z.object({type:z.literal('rule'),server:z.string(),tool:z.string(),rule:z.object({readOnly:z.boolean(),consequential:z.boolean(),sensitive:z.boolean()}).strict()}),
 z.object({type:z.literal('connect'),name:z.string()}),z.object({type:z.literal('disconnect'),name:z.string()}),
 z.object({type:z.literal('invoke'),command,chat:z.string().url().optional()}),
 z.object({type:z.literal('approval-status'),command,chat:z.string().url()}),
 z.object({type:z.literal('approve-command'),command,chat:z.string().url(),promptId:z.string()}),
 z.object({type:z.literal('reply-elicitation'),command,chat:z.string().url(),promptId:z.string(),action:z.enum(['accept','decline','cancel']),content:z.record(z.unknown()).optional()}),
 z.object({type:z.literal('reply'),id:z.string(),action:z.enum(['accept','decline','cancel']),content:z.record(z.unknown()).optional()}),
]);
