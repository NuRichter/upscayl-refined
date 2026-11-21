// npm >= 11 skips dependency install scripts unless they are allow-listed,
// which leaves Electron without its binary. Fetch it when it is missing.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = path.join(__dirname, "..", "node_modules", "electron");
const marker = path.join(dir, "path.txt");
if (fs.existsSync(dir) && !fs.existsSync(marker)) {
  console.log("electron binary missing, downloading...");
  execFileSync(process.execPath, [path.join(dir, "install.js")], { stdio: "inherit" });
}
