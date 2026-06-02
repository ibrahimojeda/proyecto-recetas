const fs = require("fs");
const parser = require("@babel/parser");
const s = fs.readFileSync("c:/Users/venta/OneDrive/Aplicaciones/proyecto-recetas/temp_check.js", "utf8");
try {
  const ast = parser.parse(s, { sourceType: "script", errorRecovery: true });
  console.log("errors", ast.errors.length);
  for (const err of ast.errors) {
    const loc = err.loc ? `${err.loc.line}:${err.loc.column}` : "n/a";
    console.log(`${err.message} @ ${loc}`);
  }
} catch (err) {
  const loc = err.loc ? `${err.loc.line}:${err.loc.column}` : "n/a";
  console.log(`throw ${err.message} @ ${loc}`);
}
