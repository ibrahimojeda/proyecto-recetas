const fs=require("fs");
const s=fs.readFileSync("c:/Users/venta/OneDrive/Aplicaciones/proyecto-recetas/temp_check.js","utf8");
let inS=false,inD=false,inT=false,inLC=false,inBC=false,esc=false;
let depth=0,line=1;
let lineStarts=[0];
for(let i=0;i<s.length;i++) if(s[i]==='\n') lineStarts.push(i+1);
const depthByLine=[];
for(let i=0;i<s.length;i++){
  const c=s[i],n=s[i+1];
  if(c==='\n'){ depthByLine.push(depth); line++; }
  if(inLC){ if(c==='\n') inLC=false; continue; }
  if(inBC){ if(c==='*'&&n=== '/') {inBC=false;i++;} continue; }
  if(inS){ if(!esc&&c==="'") inS=false; esc=!esc&&c==='\\'; continue; }
  if(inD){ if(!esc&&c==='"') inD=false; esc=!esc&&c==='\\'; continue; }
  if(inT){ if(!esc&&c==='`') inT=false; esc=!esc&&c==='\\'; continue; }
  if(c==='/'&&n==='/'){ inLC=true;i++; continue; }
  if(c==='/'&&n==='*'){ inBC=true;i++; continue; }
  if(c==="'"){ inS=true; esc=false; continue; }
  if(c==='"'){ inD=true; esc=false; continue; }
  if(c==='`'){ inT=true; esc=false; continue; }
  if(c==='{') depth++;
  else if(c==='}') depth--;
}
depthByLine.push(depth);
for(let l=1;l<=depthByLine.length;l++){
  if(l%100===0 || l>3400){
    if(l>3390 && l<3470) console.log(l,depthByLine[l-1]);
  }
}
console.log('final depth',depthByLine[depthByLine.length-1]);
