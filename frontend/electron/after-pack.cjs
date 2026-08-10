const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const launchers = {
    "metronome.cmd": '@echo off\r\nstart "" "%~dp0electron.exe"\r\n',
    "metronome_admin.cmd": '@echo off\r\nstart "" "%~dp0electron.exe" --admin\r\n',
  };
  for (const [name, contents] of Object.entries(launchers)) {
    fs.writeFileSync(path.join(context.appOutDir, name), contents, "utf8");
  }

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
