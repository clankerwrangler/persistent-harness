"""Bounded numeric observation of fixed IPython output-history owners."""

import sys
import time
from collections import defaultdict
from IPython.core.history import HistoryManager, HistoryOutput

MAX_VALUES = 10000
MAX_SECONDS = 0.025


def collect_history_memory(history):
    result = {"version": 1, "state": "complete", "outEntries": None,
              "reprEntries": None, "mimeEntries": None, "visited": 0,
              "unknown": 0, "containers": 0, "containerBytes": 0,
              "strings": 0, "stringBytes": 0, "bytes": 0, "bytesBytes": 0}
    if type(history) is not HistoryManager:
        result.update(state="unknown", unknown=1)
        return result
    # Read fixed storage fields, not trait getters, namespace keys or user hooks.
    storage = object.__getattribute__(history, "__dict__")
    traits = dict.get(storage, "_trait_values")
    if type(traits) is not dict:
        result.update(state="unknown", unknown=1)
        return result
    roots = (dict.get(traits, "output_hist"), dict.get(traits, "output_hist_reprs"),
             dict.get(storage, "outputs", HistoryManager.__dict__["outputs"]))
    for name, value in zip(("outEntries", "reprEntries", "mimeEntries"), roots):
        if type(value) is dict or type(value) is defaultdict:
            result[name] = len(value)
    seen = set()
    stack = [iter(roots)]
    deadline = time.monotonic() + MAX_SECONDS
    while stack:
        if result["visited"] >= MAX_VALUES or time.monotonic() >= deadline:
            result["state"] = "truncated"
            break
        try:
            value = next(stack[-1])
        except StopIteration:
            stack.pop()
            continue
        result["visited"] += 1
        identity = id(value)
        if identity in seen:
            continue
        seen.add(identity)
        kind = type(value)
        if kind is str:
            result["strings"] += 1
            result["stringBytes"] += sys.getsizeof(value)
        elif kind is bytes:
            result["bytes"] += 1
            result["bytesBytes"] += sys.getsizeof(value)
        elif (kind is dict or kind is defaultdict or kind is list or kind is tuple
              or kind is set or kind is frozenset):
            result["containers"] += 1
            result["containerBytes"] += sys.getsizeof(value)
            # Exact builtins only; dict keys and MIME names are never visited.
            stack.append(iter(dict.values(value)) if kind is dict or kind is defaultdict else iter(value))
        elif kind is HistoryOutput:
            fields = object.__getattribute__(value, "__dict__")
            bundle = dict.get(fields, "bundle")
            if type(bundle) is dict:
                stack.append(iter((bundle,)))
            else:
                result["unknown"] += 1
        elif not (kind is type(None) or kind is bool or kind is int or kind is float or kind is complex):
            result["unknown"] += 1
    if result["state"] == "complete" and result["unknown"]:
        result["state"] = "unknown"
    return result
