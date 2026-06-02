const fs=require("fs");
const s=fs.readFileSync("c:/Users/venta/OneDrive/Aplicaciones/proyecto-recetas/temp_check.js","utf8");
let inS=false,inD=false,inT=false,inLC=false,inBC=false,esc=false;
let depth=0,line=1;
let firstPersistent=-1;
for(let i=0;i<s.length;i++){
  const c=s[i],n=s[i+1];
  if(inLC){ if(c==='\n'){ inLC=false; line++; } continue; }
  if(inBC){ if(c==='*'&&n=== '/'){inBC=false;i++;} if(c==='\n') line++; continue; }
  if(inS){ if(!esc&&c==="'") inS=false; esc=!esc&&c==='\\'; if(c==='\n') line++; continue; }
  if(inD){ if(!esc&&c==='"') inD=false; esc=!esc&&c==='\\'; if(c==='\n') line++; continue; }
  if(inT){ if(!esc&&c==='`') inT=false; esc=!esc&&c==='\\'; if(c==='\n') line++; continue; }
  if(c==='/'&&n==='/'){ inLC=true;i++; continue; }
  if(c==='/'&&n==='*'){ inBC=true;i++; continue; }
  if(c==="'"){ inS=true; esc=false; continue; }
  if(c==='"'){ inD=true; esc=false; continue; }
  if(c==='`'){ inT=true; esc=false; continue; }
  if(c==='{'){
    depth++;
    if(depth===1) console.log('enter depth1 at line',line);
  } else if(c==='}'){
    depth--;
    if(depth===0) console.log('back to depth0 at line',line);
  }
  if(c==='\n') line++;
}
console.log('end depth',depth);
