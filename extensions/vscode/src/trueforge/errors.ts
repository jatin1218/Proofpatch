export function redact(value:string):string{
 return value.replace(/AIza[\w-]{20,}/g,'[REDACTED]').replace(/Bearer\s+[^\s"',}]+/gi,'Bearer [REDACTED]').replace(/((?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,'$1[REDACTED]');
}
export function connectionError(error:unknown):Error{
 const e=error as {statusCode?:number;message?:string;name?:string;body?:{error?:{message?:string}}};
 const status=e?.statusCode;const msg=String(e?.body?.error?.message??e?.message??error);
 if(status===401||status===403)return new Error('TrueForge authentication failed. Check its login configuration and use ProofPatch: Set TrueForge Access Token if required. Gemini credentials belong in TrueForge Settings → Models.');
 if(status===404)return new Error('TrueForge could not find the session, model or connector. Reconnect and check the selected resources.');
 if(status===422)return new Error('TrueForge rejected the configuration: '+redact(msg).slice(0,1200));
 if(status===429)return new Error('TrueForge or the model provider is rate-limited. Wait and retry; the turn was not automatically resubmitted.');
 if(/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg))return new Error('Cannot reach local TrueForge. Start the server and check proofpatch.trueforge.baseUrl.');
 if(/timeout|timed out/i.test(msg))return new Error('TrueForge timed out. Check server/provider connectivity before retrying.');
 return new Error(redact(msg).slice(0,1600));
}
