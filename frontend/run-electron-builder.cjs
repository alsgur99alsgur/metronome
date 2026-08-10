const fs = require("node:fs/promises");

const originalRename = fs.rename.bind(fs);

fs.rename = async function renameWithCopyFallback(source, destination) {
  try {
    await originalRename(source, destination);
  } catch (error) {
    await fs.cp(source, destination, { recursive: true, force: true });
    console.log(
      `electron-builder rename failed (${error.code}); copied ${source} to ${destination} instead.`,
    );
  }
};

require("electron-builder/out/cli/cli");
