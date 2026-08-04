from typing import Callable, List

import pandas as pd


class Task:
    def __init__(self, task_id: str, name: str, task_type: str, func: Callable):
        self.id = task_id
        self.name = name
        self.type = task_type
        self.func = func
        self.parents: List[Task] = []
        self.children: List[Task] = []
        self.remaining = 0
        self.internal_loop_task = False
        self.loop_owner_id = None
        self.loop_out_task = None
        self.loop_body_tasks: List[Task] = []
        self.loop_body_roots: List[Task] = []
        self.loop_data = {}
        self.loop_params = {}
        self.loop_iterations = None
        self.loop_dependency_parent_ids = set()

    def __rshift__(self, other):
        self.children.append(other)
        other.parents.append(self)
        other.remaining += 1
        return other

    def execute(self, inputs: list[pd.DataFrame]) -> pd.DataFrame:
        return self.func(inputs)
