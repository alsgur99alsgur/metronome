export const folderOf = (name) => name.includes("/")
  ? name.slice(0, name.lastIndexOf("/"))
  : "";

export const folderRows = (directories) => {
  const children = new Map();
  directories.filter(Boolean).forEach((path) => {
    const parent = folderOf(path);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(path);
  });
  const rows = [{ path: "", depth: 0 }];
  const append = (parent, depth) => {
    (children.get(parent) || []).sort().forEach((path) => {
      rows.push({ path, depth });
      append(path, depth + 1);
    });
  };
  append("", 1);
  return rows;
};
