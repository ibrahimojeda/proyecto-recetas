const fs = require('fs');
const code = fs.readFileSync('c:/Users/venta/OneDrive/Aplicaciones/proyecto-recetas/temp_check.js', 'utf8');
let i = 0;
let line = 1;
let col = 0;
const stack = [];
let state = 'code';
let quote = '';
while (i < code.length) {
  const ch = code[i];
  const nx = code[i + 1];
  if (ch === '\n') {
    line += 1;
    col = 0;
    if (state === 'line') state = 'code';
    i += 1;
    continue;
  }
  col += 1;
  if (state === 'code') {
    if (ch === '\'' || ch === '"' || ch === '`') {
      state = 'str';
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && nx === '/') {
      state = 'line';
      i += 2;
      col += 1;
      continue;
    }
    if (ch === '/' && nx === '*') {
      state = 'block';
      i += 2;
      col += 1;
      continue;
    }
    if (ch === '{') stack.push({ line, col });
    if (ch === '}') {
      if (!stack.length) {
        console.log('extra } at', line, col);
        process.exit(0);
      }
      stack.pop();
    }
    i += 1;
    continue;
  }
  if (state === 'str') {
    if (ch === '\\') {
      i += 2;
      col += 1;
      continue;
    }
    if (ch === quote) {
      state = 'code';
      i += 1;
      continue;
    }
    i += 1;
    continue;
  }
  if (state === 'block') {
    if (ch === '*' && nx === '/') {
      state = 'code';
      i += 2;
      col += 1;
      continue;
    }
    i += 1;
    continue;
  }
}
console.log('unclosed count', stack.length);
console.log('last openings', stack.slice(-10));
