import {TrueForge, type TrueForgeApi} from '@truefoundry/trueforge-sdk';
export type StreamEvent=TrueForgeApi.TurnStreamingEvent;
export interface RuntimePort {
 createSession(spec:TrueForgeApi.AgentSpec):Promise<string>;
 start(session:string,content:string):Promise<AsyncIterable<StreamEvent>>;
 resume(session:string,turn:string,cursor:string,answers:TrueForgeApi.TurnUserEventMessage[],signal:AbortSignal):Promise<AsyncIterable<StreamEvent>>;
 cancel(session:string):Promise<void>;
 status(session:string):Promise<string|undefined>;
}
export class SdkTransport implements RuntimePort{
 constructor(readonly client:TrueForge){}
 async createSession(spec:TrueForgeApi.AgentSpec){return (await this.client.sessions.create({agent:{spec}},{timeoutInSeconds:20,maxRetries:0})).data.id;}
 async start(session:string,content:string){return this.client.sessions.createTurnStream(session,{input:[{type:'user.message',content}]},{timeoutInSeconds:30,maxRetries:0,stream:{reconnectionEnabled:false}});}
 async resume(session:string,turn:string,cursor:string,answers:TrueForgeApi.TurnUserEventMessage[],signal:AbortSignal){
  const abort=new AbortController();
  const stream=await this.client.sessions.subscribeToTurn(session,turn,{afterEventId:cursor},{abortSignal:AbortSignal.any([signal,abort.signal]),timeoutInSeconds:30,maxRetries:0,stream:{reconnectionEnabled:false}});
  try{await this.client.sessions.createTurnEvents(session,turn,{events:answers},{abortSignal:signal,timeoutInSeconds:20,maxRetries:0});return stream;}
  catch(e){abort.abort();throw e;}
 }
 async cancel(session:string){await this.client.sessions.cancel(session,{}, {timeoutInSeconds:20,maxRetries:0});}
 async status(session:string){return (await this.client.sessions.get(session,{timeoutInSeconds:5,maxRetries:0})).data.lastTurnDetails?.state.status;}
}
export function sdkClient(baseUrl:string,token?:string){return new TrueForge({baseUrl,token,timeoutInSeconds:30,maxRetries:0,stream:{reconnectionEnabled:false}});}
