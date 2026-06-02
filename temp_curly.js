const fs=require('fs');
const s=fs.readFileSync(process.argv[2],'utf8');
let inS=false,inD=false,inT=false,inLC=false,inBC=false,esc=false;
const stack=[];
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
  if(c==='{') stack.push(i);
  else if(c==='}'){
    if(!stack.length){ console.log('extra } at',i); process.exit(0); }
    stack.pop();
  }
}
console.log('unclosed { count',stack.length);
if(stack.length){
  const i=stack[stack.length-1];
  const line=s.slice(0,i).split('\n').length;
  console.log('last unclosed { line',line);
  const lines=s.split('\n');
  console.log(lines.slice(Math.max(0,line-3),line+6).join('\n'));
}
