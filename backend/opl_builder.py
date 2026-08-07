"""Build and solve Pyomo models from current OPL node definitions."""

import os
import re
import shutil

import pandas as pd
import pyomo.environ as pyo
from pyomo.opt import ProblemFormat


_IDENTIFIER = re.compile(r"^[A-Za-z_]\w*$")
_TOKEN = re.compile(r"[A-Za-z_]\w*")
_SUM_INDEXES = re.compile(r"sum\s*\(\s*\[([^\]]*)\]")
_BRACKET_INDEXES = re.compile(r"\[([^\]]+)\]")


class MissingOplComponentKey(Exception):
    """Raised when a sparse OPL Param or Var key is not initialized."""


def _opl_component(component, key):
    if key not in component:
        raise MissingOplComponentKey(f"{component.name}{key!r}")
    return component[key]


def _opl_optional_term(func):
    try:
        return func()
    except MissingOplComponentKey:
        return 0


def _require_identifier(value, label):
    name = str(value or "").strip()
    if not _IDENTIFIER.fullmatch(name):
        raise ValueError(f"{label} must be a valid Python identifier: {name or '<empty>'}")
    return name


def _split_top_level_comma(value):
    depth = 0
    for index, char in enumerate(value):
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "," and depth == 0:
            return value[:index], value[index + 1 :]
    return None


def _translate_expression(
    value,
    component_names,
    local_names=None,
    sparse_names=None,
    optional_params=False,
):
    expression = str(value or "").strip()
    local_names = set(local_names or ())
    sparse_names = set(sparse_names or ())
    replacements = []
    offset = 0
    while True:
        offset = expression.find("sum(", offset)
        if offset < 0:
            break
        depth = 1
        end = offset + 4
        while end < len(expression) and depth:
            if expression[end] == "(":
                depth += 1
            elif expression[end] == ")":
                depth -= 1
            end += 1
        if depth:
            raise ValueError(f"Unclosed sum expression: {value}")
        parts = _split_top_level_comma(expression[offset + 4 : end - 1])
        if not parts:
            raise ValueError("sum syntax must be sum([index1, index2], expression).")
        index_text, body_text = (part.strip() for part in parts)
        if not (index_text.startswith("[") and index_text.endswith("]")):
            raise ValueError("sum indexes must be enclosed in square brackets.")
        indexes = [
            _require_identifier(item.strip(), "Sum index")
            for item in index_text[1:-1].split(",")
            if item.strip()
        ]
        if not indexes:
            raise ValueError("sum requires at least one index.")
        unknown = [name for name in indexes if name not in component_names]
        if unknown:
            raise ValueError(f"sum references unknown Set: {', '.join(unknown)}")
        body = _translate_expression(
            body_text,
            component_names,
            local_names | set(indexes),
            sparse_names,
            optional_params=False,
        )
        generators = " ".join(f"for {name} in model.{name}" for name in indexes)
        marker = f"__PYOMO_SUM_{len(replacements)}__"
        replacements.append(
            f"pyo.quicksum(_opl_optional_term(lambda: {body}) {generators})"
        )
        expression = f"{expression[:offset]}{marker}{expression[end:]}"
        offset += len(marker)

    def replace_token(match):
        name = match.group(0)
        if name in local_names or name not in component_names:
            return name
        if match.start() and expression[match.start() - 1] == ".":
            return name
        return f"model.{name}"

    translated = _TOKEN.sub(replace_token, expression)
    for component_name in sorted(sparse_names, key=len, reverse=True):
        access_pattern = re.compile(
            rf"model\.{re.escape(component_name)}\s*\[([^\]]+)\]"
        )

        def replace_component_access(match, name=component_name):
            access = f"_opl_component(model.{name}, ({match.group(1)}))"
            if optional_params:
                return f"_opl_optional_term(lambda: {access})"
            return access

        translated = access_pattern.sub(replace_component_access, translated)
    for index, replacement in enumerate(replacements):
        translated = translated.replace(f"__PYOMO_SUM_{index}__", replacement)
    return translated


def _normalize_equality(value):
    return re.sub(r"(^|[^<>=!])=([^=]|$)", r"\1==\2", str(value or ""))


def _expression_indexes(value, set_names):
    bound = set()
    for match in _SUM_INDEXES.finditer(str(value or "")):
        bound.update(name.strip() for name in match.group(1).split(","))
    result = []
    for match in _BRACKET_INDEXES.finditer(str(value or "")):
        for name in (item.strip() for item in match.group(1).split(",")):
            if name in set_names and name not in bound and name not in result:
                result.append(name)
    return result


def _input_dataframe(input_dataframes, node_id, label):
    if not node_id:
        raise ValueError(f"{label} requires an input node.")
    dataframe = input_dataframes.get(node_id)
    if not isinstance(dataframe, pd.DataFrame):
        raise TypeError(f"{label} input must be a pandas DataFrame: {node_id}")
    return dataframe


def _require_column(dataframe, column, label):
    if not column:
        raise ValueError(f"{label} requires a column.")
    if column not in dataframe.columns:
        raise KeyError(f"{label} column not found: {column}")


def _write_model_artifacts(model, artifact_dirs, node_id):
    if not artifact_dirs:
        return
    added_feasibility_objective = False
    if next(model.component_data_objects(pyo.Objective, active=True), None) is None:
        setattr(model, "_opl_feasibility_objective", pyo.Objective(expr=0))
        added_feasibility_objective = True
    safe_node_id = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(node_id or "opl")).strip("_") or "opl"
    first_dir = artifact_dirs[0]
    os.makedirs(first_dir, exist_ok=True)
    first_lp = os.path.join(first_dir, f"{safe_node_id}.lp")
    first_mps = os.path.join(first_dir, f"{safe_node_id}.mps")
    try:
        model.write(
            first_lp,
            format=ProblemFormat.cpxlp,
            io_options={"symbolic_solver_labels": True},
        )
        model.write(
            first_mps,
            format=ProblemFormat.mps,
            io_options={"symbolic_solver_labels": True},
        )
        for artifact_dir in artifact_dirs[1:]:
            os.makedirs(artifact_dir, exist_ok=True)
            shutil.copyfile(first_lp, os.path.join(artifact_dir, f"{safe_node_id}.lp"))
            shutil.copyfile(first_mps, os.path.join(artifact_dir, f"{safe_node_id}.mps"))
    finally:
        if added_feasibility_objective:
            model.del_component("_opl_feasibility_objective")


def build_and_solve_opl(data, input_dataframes, artifact_dirs=None, node_id=None):
    model = pyo.ConcreteModel()
    sets = data.get("sets") or []
    params = data.get("params") or []
    variables = data.get("variables") or []
    expressions = data.get("expressions") or []
    set_by_name = {}

    for item in sets:
        name = _require_identifier(item.get("name"), "Set name")
        dataframe = _input_dataframe(input_dataframes, item.get("inputNodeId"), f"Set {name}")
        column = item.get("column")
        _require_column(dataframe, column, f"Set {name}")
        setattr(model, name, pyo.Set(initialize=dataframe[column].unique()))
        set_by_name[name] = item

    for item in params:
        name = _require_identifier(item.get("name"), "Parameter name")
        dataframe = _input_dataframe(input_dataframes, item.get("inputNodeId"), f"Parameter {name}")
        column = item.get("column")
        _require_column(dataframe, column, f"Parameter {name}")
        index_names = item.get("indexSets") or []
        index_sets = []
        index_columns = []
        for index_name in index_names:
            if index_name not in set_by_name:
                raise ValueError(f"Parameter {name} references unknown Set: {index_name}")
            index_sets.append(getattr(model, index_name))
            index_column = set_by_name[index_name].get("column")
            _require_column(dataframe, index_column, f"Parameter {name} index {index_name}")
            index_columns.append(index_column)
        if index_sets:
            initializer = dataframe.set_index(index_columns)[column].to_dict()
            setattr(model, name, pyo.Param(*index_sets, initialize=initializer))
        else:
            if dataframe.empty:
                raise ValueError(f"Scalar parameter {name} input is empty.")
            setattr(model, name, pyo.Param(initialize=dataframe[column].iloc[0]))

    domains = {
        "nonNegativeReal": pyo.NonNegativeReals,
        "nonNegativeInteger": pyo.NonNegativeIntegers,
        "binary": pyo.Binary,
    }
    for item in variables:
        name = _require_identifier(item.get("name"), "Variable name")
        index_names = item.get("indexSets") or []
        domain_name = item.get("domain") or "nonNegativeReal"
        if domain_name not in domains:
            raise ValueError(f"Unsupported variable domain: {domain_name}")
        if not index_names:
            setattr(model, name, pyo.Var(domain=domains[domain_name]))
            continue
        index_items = []
        for index_name in index_names:
            if index_name not in set_by_name:
                raise ValueError(f"Variable {name} references unknown Set: {index_name}")
            index_items.append(set_by_name[index_name])
        input_node_ids = {item.get("inputNodeId") for item in index_items}
        if len(input_node_ids) != 1 or not next(iter(input_node_ids), None):
            raise ValueError(
                f"Variable {name} index Sets must use the same input node."
            )
        input_node_id = next(iter(input_node_ids))
        dataframe = _input_dataframe(
            input_dataframes, input_node_id, f"Variable {name}"
        )
        index_columns = [item.get("column") for item in index_items]
        for index_name, index_column in zip(index_names, index_columns):
            _require_column(dataframe, index_column, f"Variable {name} index {index_name}")
        unique_keys = dataframe[index_columns].drop_duplicates()
        if len(index_names) == 1:
            initializer = unique_keys[index_columns[0]].tolist()
        else:
            initializer = list(unique_keys.itertuples(index=False, name=None))
        internal_set_name = f"_opl_index_{name}"
        if hasattr(model, internal_set_name):
            raise ValueError(f"Reserved OPL component name is already used: {internal_set_name}")
        setattr(
            model,
            internal_set_name,
            pyo.Set(dimen=len(index_names), initialize=initializer),
        )
        setattr(
            model,
            name,
            pyo.Var(getattr(model, internal_set_name), domain=domains[domain_name]),
        )

    component_names = set(set_by_name)
    component_names.update(_require_identifier(item.get("name"), "Parameter name") for item in params)
    component_names.update(_require_identifier(item.get("name"), "Variable name") for item in variables)
    eval_globals = {"__builtins__": {}, "model": model, "pyo": pyo, "sum": sum}
    sparse_names = {
        _require_identifier(item.get("name"), "Parameter name") for item in params
    }
    sparse_names.update(
        _require_identifier(item.get("name"), "Variable name")
        for item in variables
        if item.get("indexSets")
    )
    eval_globals.update(
        {
            "_opl_component": _opl_component,
            "_opl_optional_term": _opl_optional_term,
        }
    )

    objectives = [item for item in expressions if item.get("kind") == "objective"]
    if len(objectives) > 1:
        raise ValueError("OPL model supports exactly one objective.")
    if objectives:
        item = objectives[0]
        name = _require_identifier(item.get("name"), "Objective name")
        formula = _translate_expression(
            item.get("formula"),
            component_names,
            sparse_names=sparse_names,
            optional_params=True,
        )
        if not formula:
            raise ValueError(f"Objective {name} requires a formula.")
        expression = eval(compile(formula, f"<opl-objective-{name}>", "eval"), eval_globals)
        sense = pyo.minimize if data.get("objectiveSense") == "minimize" else pyo.maximize
        setattr(model, name, pyo.Objective(expr=expression, sense=sense))

    set_names = set(set_by_name)
    for item in (row for row in expressions if row.get("kind") == "constraint"):
        name = _require_identifier(item.get("name"), "Constraint name")
        formula_source = _normalize_equality(item.get("formula")).strip()
        condition_source = _normalize_equality(item.get("condition")).strip()
        if not formula_source:
            raise ValueError(f"Constraint {name} requires a formula.")
        rule_indexes = _expression_indexes(formula_source, set_names)
        for index_name in _expression_indexes(condition_source, set_names):
            if index_name not in rule_indexes:
                rule_indexes.append(index_name)
        formula_code = compile(
            _translate_expression(
                formula_source,
                component_names,
                rule_indexes,
                sparse_names=sparse_names,
            ),
            f"<opl-constraint-{name}>",
            "eval",
        )
        condition_code = (
            compile(
                _translate_expression(
                    condition_source,
                    component_names,
                    rule_indexes,
                    sparse_names=sparse_names,
                ),
                f"<opl-condition-{name}>",
                "eval",
            )
            if condition_source
            else None
        )

        def rule(current_model, *index_values, _indexes=rule_indexes, _formula=formula_code, _condition=condition_code):
            locals_scope = dict(zip(_indexes, index_values))
            scope = {
                "__builtins__": {},
                "model": current_model,
                "pyo": pyo,
                "_opl_component": _opl_component,
                "_opl_optional_term": _opl_optional_term,
                **locals_scope,
            }
            try:
                if _condition is not None and not eval(_condition, scope, locals_scope):
                    return pyo.Constraint.Skip
                return eval(_formula, scope, locals_scope)
            except MissingOplComponentKey:
                return pyo.Constraint.Skip

        index_sets = [getattr(model, index_name) for index_name in rule_indexes]
        setattr(model, name, pyo.Constraint(*index_sets, rule=rule))

    solver_name = data.get("solver") or "highs"
    if solver_name not in {"highs", "gurobi", "cplex"}:
        raise ValueError(f"Unsupported OPL solver: {solver_name}")
    solver = pyo.SolverFactory(solver_name)
    if not solver.available(exception_flag=False):
        raise RuntimeError(f"Selected OPL solver is not available: {solver_name}")
    try:
        timeout_seconds = float(data.get("solverTimeoutSeconds", 60))
    except (TypeError, ValueError) as exc:
        raise ValueError("OPL solver timeout must be a number.") from exc
    try:
        mip_gap = float(data.get("mipGap", 0.01))
    except (TypeError, ValueError) as exc:
        raise ValueError("OPL MIP gap must be a number.") from exc
    if timeout_seconds <= 0:
        raise ValueError("OPL solver timeout must be greater than 0 seconds.")
    if not 0 <= mip_gap <= 1:
        raise ValueError("OPL MIP gap must be between 0 and 1.")
    timeout_options = {"highs": "time_limit", "gurobi": "TimeLimit", "cplex": "timelimit"}
    mip_gap_options = {"highs": "mip_rel_gap", "gurobi": "MIPGap", "cplex": "mipgap"}
    solver.options[timeout_options[solver_name]] = timeout_seconds
    solver.options[mip_gap_options[solver_name]] = mip_gap
    _write_model_artifacts(model, artifact_dirs or [], node_id)
    results = solver.solve(model)
    status = str(results.solver.status)
    termination = str(results.solver.termination_condition)
    objective_value = None
    if objectives:
        objective_value = pyo.value(getattr(model, objectives[0]["name"]), exception=False)

    rows = []
    for item in variables:
        name = item["name"]
        variable = getattr(model, name)
        index_names = item.get("indexSets") or []
        if variable.is_indexed():
            for key in variable:
                values = key if isinstance(key, tuple) else (key,)
                row = {"variable": name, "value": pyo.value(variable[key], exception=False)}
                row.update({index_names[index] if index < len(index_names) else f"index_{index + 1}": value for index, value in enumerate(values)})
                rows.append(row)
        else:
            rows.append({"variable": name, "value": pyo.value(variable, exception=False)})
    if not rows:
        rows.append({"variable": None, "value": None})
    for row in rows:
        row["solver"] = solver_name
        row["solver_status"] = status
        row["termination_condition"] = termination
        row["objective_value"] = objective_value
    print(f"OPL {data.get('name', '')}: solver={solver_name} status={status} termination={termination}")
    return pd.DataFrame(rows)
