export const VARIABLE_TYPES = ["string", "number", "datetime"];

export const variableInputType = (type) => {
  if (type === "number") return "number";
  if (type === "datetime") return "datetime-local";
  return "text";
};

export const currentDateTimeInputValue = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};

export const variableInputValue = (value, type) => {
  if (value == null) return "";
  if (type !== "datetime" || !value) return String(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};

export const coerceVariableValue = (value, type, name = "Variable") => {
  if (!VARIABLE_TYPES.includes(type)) throw new Error(`${name} must have a type.`);
  if (type === "string") return String(value ?? "");
  if (type === "number") {
    if (String(value ?? "").trim() === "") throw new Error(`${name} requires a number.`);
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${name} requires a valid number.`);
    return number;
  }
  if (String(value ?? "").trim() === "") throw new Error(`${name} requires a datetime.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} requires a valid datetime.`);
  return date.toISOString();
};
