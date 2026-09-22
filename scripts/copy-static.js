const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src", "frontend");
const outDir = path.join(__dirname, "..", "dist", "public");

fs.mkdirSync(outDir, { recursive: true });

for (const file of ["index.html", "style.css"]) {
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}

console.log("Copied static frontend assets to dist/public");
