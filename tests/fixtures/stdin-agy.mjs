const args=process.argv.slice(2);
let input='';for await(const chunk of process.stdin)input+=chunk;
const stream=args.includes('stream-json');
if(stream){
  const event=JSON.parse(input);
  if(event.event!=='user'||typeof event.message?.content!=='string')process.exit(7);
  console.log(JSON.stringify({event:'init'}));
  console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'stdin received',num_turns:1}}));
}else console.log(JSON.stringify({status:'SUCCESS',response:'argv received',num_turns:1}));
