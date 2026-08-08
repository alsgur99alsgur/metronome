from datetime import date, datetime, time


def json_default(value):
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    item = getattr(value, "item", None)
    if callable(item):
        return item()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")
