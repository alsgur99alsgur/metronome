const NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const DIRECTORY_PATTERN = /^[A-Za-z0-9_.-]+$/;

export const validateName = (value, label) => {
  const name = String(value ?? "");
  if (!name) throw new Error(`${label} is required.`);
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`${label} may contain only English letters, numbers, and underscores.`);
  }
  return name;
};

export const validateConcertName = (value) => validateName(value, "Concert name");

export const validateNodeName = (value) => validateName(value, "Node name");

export const validateCacheName = (value) => validateName(value, "Cache name");

export const validateConcertPath = (value) => {
  const path = String(value ?? "").replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.endsWith("/")) {
    throw new Error("Concert name is required.");
  }
  const parts = path.split("/");
  const name = validateConcertName(parts.pop());
  for (const directory of parts) {
    if (!DIRECTORY_PATTERN.test(directory) || directory === "." || directory === "..") {
      throw new Error("Concert directory may contain only English letters, numbers, underscores, hyphens, and periods.");
    }
  }
  return [...parts, name].join("/");
};

export const concertBaseName = (value) => {
  const parts = String(value ?? "").replace(/\\/g, "/").split("/");
  return validateConcertName(parts.at(-1));
};
