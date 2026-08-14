import math


VARIABLE_TYPES = {"string", "number"}
INPUT_VARIABLE_TYPES = VARIABLE_TYPES


def coerce_variable_value(value, variable_type, name):
    if variable_type not in VARIABLE_TYPES:
        raise ValueError(f"{name} must have one of these types: string, number.")
    if variable_type == "string":
        return "" if value is None else str(value)
    if variable_type == "number":
        if isinstance(value, bool) or value is None or str(value).strip() == "":
            raise ValueError(f"{name} requires a number.")
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} requires a valid number.") from exc
        if not math.isfinite(number):
            raise ValueError(f"{name} requires a finite number.")
        return int(number) if number.is_integer() else number
    raise ValueError(f"{name} must have one of these types: string, number.")


def runtime_params(global_variables=None, input_variables=None, params=None):
    definitions = {}
    result = {}
    provided_params = {
        str(raw_name)[1:] if str(raw_name).startswith("$") else str(raw_name): value
        for raw_name, value in (params or {}).items()
    }
    for items, value_key, allowed_types, label in (
        (global_variables or [], "value", VARIABLE_TYPES, "Global"),
        (input_variables or [], "defaultValue", INPUT_VARIABLE_TYPES, "Input"),
    ):
        for item in items:
            if not isinstance(item, dict):
                continue
            raw_name = str(item.get("name", "")).strip()
            name = raw_name[1:] if raw_name.startswith("$") else raw_name
            if not name:
                continue
            if name in definitions:
                raise ValueError(f"Duplicate variable definition: ${name}")
            if item.get("type") not in allowed_types:
                raise ValueError(
                    f"{label} variable ${name} type must be one of: "
                    f"{', '.join(sorted(allowed_types))}."
                )
            definitions[name] = item
            value = provided_params[name] if name in provided_params else item.get(value_key)
            result[name] = coerce_variable_value(value, item.get("type"), f"${name}")
    for name in provided_params:
        definition = definitions.get(name)
        if definition is None:
            raise ValueError(f"Input variable definition not found: ${name}")
    return result
