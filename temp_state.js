const fs=require('fs');
const s=fs.readFileSync(process.argv[2],'utf8');
let inS=false,inD=false,inT=false,inLC=false,inBC=false,esc=false;
let line=1, tStart=0, sStart=0, dStart=0;
for(let i=0;i<s.length;i++){
  const c=s[i], n=s[i+1];
  if(c==='\n') line++;
  if(inLC){ if(c==='\n') inLC=false; continue; }
  if(inBC){ if(c==='*'&&n==='/'){ inBC=false;i++; } continue; }
  if(inS){ if(!esc&&c==="'") inS=false; esc=!esc&&c==='\\'; continue; }
  if(inD){ if(!esc&&c==='"') inD=false; esc=!esc&&c==='\\'; continue; }
  if(inT){ if(!esc&&c==='`') inT=false; esc=!esc&&c==='\\'; continue; }
  if(c==='/'&&n==='/'){ inLC=true;i++; continue; }
  if(c==='/'&&n==='*'){ inBC=true;i++; continue; }
  if(c==="'"){ inS=true; sStart=line; esc=false; continue; }
  if(c==='"'){ inD=true; dStart=line; esc=false; continue; }
  if(c==='`'){ inT=true; tStart=line; esc=false; continue; }
}
console.log({inS,inD,inT,inLC,inBC,sStart,dStart,tStart,line});
