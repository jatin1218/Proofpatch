import {parse} from 'yaml';
import {z} from 'zod';
import type {TrueForgeApi} from '@truefoundry/trueforge-sdk';
const disabled=z.object({enabled:z.literal(false)});
const template=z.object({name:z.literal('proofpatch'),instructions:z.string().min(100),require_approval_for_tools:z.array(z.string()).min(1),config:z.object({sandbox:disabled,web_search:disabled,memory:disabled,generative_ui:disabled,ask_user_questions:disabled,dynamic_sub_agents:disabled,iteration_limit:z.number().int().min(1).max(100)})});
export function agentSpec(yaml:string,model:string,mcpServer?:string):TrueForgeApi.AgentSpec{
 const t=template.parse(parse(yaml));if(!model.trim()||!model.includes('/'))throw new Error('Select a configured provider/model from TrueForge.');
 return {model:{name:model},instructions:t.instructions,mcpServers:mcpServer?[{name:mcpServer,enableTools:['@all'],requireApprovalForTools:t.require_approval_for_tools,preload:true}]:[],
 config:{sandbox:t.config.sandbox,webSearch:t.config.web_search,memory:t.config.memory,generativeUi:t.config.generative_ui,askUserQuestions:t.config.ask_user_questions,dynamicSubAgents:t.config.dynamic_sub_agents,iterationLimit:t.config.iteration_limit}};
}
export function localBaseUrl(input:string):string{
 const u=new URL(input);
 if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error('Use a local TrueForge URL such as http://localhost:8790 (no credentials or path).');
 return u.origin;
}
