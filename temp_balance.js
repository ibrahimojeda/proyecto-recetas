const fs=require('fs');
const s=fs.readFileSync(process.argv[2],'utf8');
const stack=[];
let inS=false,inD=false,inT=false,inLC=false,inBC=false,esc=false;
for(let i=0;i<s.length;i++){
  const c=s[i], n=s[i+1];
  if(inLC){ if(c==='\n') inLC=false; continue; }
  if(inBC){ if(c==='*'&&n==='/'){ inBC=false;i++; } continue; }
  if(inS){ if(!esc&&c==="'") inS=false; esc=!esc&&c==='\\'; continue; }
  if(inD){ if(!esc&&c==='"') inD=false; esc=!esc&&c==='\\'; continue; }
  if(inT){ if(!esc&&c==='`') inT=false; esc=!esc&&c==='\\'; continue; }
  if(c==='/'&&n==='/'){ inLC=true;i++; continue; }
  if(c==='/'&&n==='*'){ inBC=true;i++; continue; }
  if(c==="'"){ inS=true; esc=false; continue; }
  if(c==='"'){ inD=true; esc=false; continue; }
  if(c==='`'){ inT=true; esc=false; continue; }
  if(c==='{'||c==='('||c==='[') stack.push({c,i});
  else if(c==='}'||c===')'||c===']'){
    const top=stack.pop();
    if(!top){ console.log('extra closing',c,'at',i); process.exit(0); }
  }
}
if(stack.length){
  const last=stack[stack.length-1];
  const pre=s.slice(0,last.i);
  const line=pre.split('\n').length;
  console.log('unclosed',last.c,'at index',last.i,'line',line);
  console.log('tail from line',line,':');
  console.log(s.split('\n').slice(Math.max(0,line-3),line+4).join('\n'));
}else{
  console.log('balanced delimiters');
}
