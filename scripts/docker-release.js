const { execSync } = require("child_process");
const path = require("path");
const { version } = require("../package.json");

const ROOT = path.join(__dirname, "..");
const IMAGE = "harbor.imthespyke.fr/imthespyke/vod-manager";
const TAGS = ["latest", version];

const args = new Set(process.argv.slice(2));
const doBuild = args.size === 0 || args.has("--build");
const doPush = args.size === 0 || args.has("--push");

function run(command) {
  console.log(`\n> ${command}\n`);
  execSync(command, { cwd: ROOT, stdio: "inherit" });
}

if (doBuild) {
  const tagArgs = TAGS.map((tag) => `-t ${IMAGE}:${tag}`).join(" ");
  run(`docker build ${tagArgs} .`);
}

if (doPush) {
  for (const tag of TAGS) {
    run(`docker push ${IMAGE}:${tag}`);
  }
}

console.log(`\nDone: ${TAGS.map((tag) => `${IMAGE}:${tag}`).join(", ")}`);
