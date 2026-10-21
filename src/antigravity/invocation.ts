export type PromptTransport='stdin'|'argv';
export function invocationFor(prompt:string,timeout:number,transport:PromptTransport,model:string|null=null) {
  const common=['--print-timeout',`${timeout}s`,'--disable-slash-commands',...(model?['--model',model]:[])];
  return transport==='argv'
    ? {args:['--print',prompt,'--output-format','json',...common],stdin:undefined}
    : {args:['--input-format','stream-json','--output-format','stream-json',...common],stdin:JSON.stringify({event:'user',message:{content:prompt}})+'\n'};
}
export function finalEnvelope(output:string,transport:PromptTransport):Record<string,unknown> {
  if(transport==='argv')return JSON.parse(output) as Record<string,unknown>;
  const results:Record<string,unknown>[]=[];
  for(const line of output.split(/\r?\n/).filter(line=>line.trim())){
    const event=JSON.parse(line) as {event?:string;result?:unknown};
    if(event?.event==='result'){
      if(typeof event.result!=='object'||event.result===null||Array.isArray(event.result))throw new Error('Invalid stream result');
      results.push(event.result as Record<string,unknown>);
    }
  }
  if(results.length!==1)throw new Error('Expected exactly one final stream result');
  return results[0];
}
