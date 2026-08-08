const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const mainExecutable = path.join(context.appOutDir, "metronome.exe");
  const adminExecutable = path.join(context.appOutDir, "metronome_admin.exe");
  fs.copyFileSync(mainExecutable, adminExecutable);

  const serversPath = path.join(context.appOutDir, "servers.json");
  fs.writeFileSync(
    serversPath,
    `${JSON.stringify(
      [{ name: "Local", host: "127.0.0.1", port: 8000 }],
      null,
      2,
    )}\n`,
    "utf8",
  );
};
