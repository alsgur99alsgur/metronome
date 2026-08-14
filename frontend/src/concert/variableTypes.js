export const VARIABLE_TYPES = ["string", "number"];
export const INPUT_VARIABLE_TYPES = VARIABLE_TYPES;

export const variableInputType = (type) => {
  if (type === "number") return "number";
  return "text";
};

export const variableInputValue = (value) => {
  if (value == null) return "";
  return String(value);
};

export const coerceVariableValue = (value, type, name = "Variable") => {
  if (!VARIABLE_TYPES.includes(type)) throw new Error(`${name} type must be string or number.`);
  if (type === "string") return String(value ?? "");
  if (type === "number") {
    if (String(value ?? "").trim() === "") throw new Error(`${name} requires a number.`);
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${name} requires a valid number.`);
    return number;
  }
  throw new Error(`${name} type must be string or number.`);
};
