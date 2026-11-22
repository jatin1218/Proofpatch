import { z } from 'zod';
const id=z.string().min(1).max(512);
export const clientMessage = z.discriminatedUnion('type',[
 z.object({type:z.literal('connect')}),
 z.object({type:z.literal('ready')}), z.object({type:z.literal('send'),instruction:z.string().trim().min(1).max(32000)}),
 z.object({type:z.literal('stop')}),z.object({type:z.literal('demo')}),z.object({type:z.literal('inline')}),
 z.object({type:z.literal('decide'),reviewId:id,revision:z.number().int().nonnegative(),fileId:id,hunkId:id,decision:z.enum(['accepted','rejected'])}),
 z.object({type:z.literal('diff'),fileId:id}), z.object({type:z.literal('evidence'),id}),
 z.object({type:z.literal('apply')}),z.object({type:z.literal('undo')}),z.object({type:z.literal('validate')})
]);
