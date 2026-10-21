const [version,missing,flag]=process.argv.slice(2);
if(flag==='--version')console.log(version);
else console.error(['--print','--output-format','--print-timeout','--disable-slash-commands'].filter(value=>value!==missing).join('\n'));
