const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const adminLauncher = path.join(context.appOutDir, "metronome_admin.cmd");
  fs.writeFileSync(
    adminLauncher,
    '@echo off\r\nstart "" "%~dp0metronome.exe" --admin\r\n',
    "utf8",
  );

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
