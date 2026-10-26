"""Compatibility entry for the shared bounded Linux memory observer."""
try:
    import _linux_memory as _shared
except ModuleNotFoundError:
    # Direct source-file use has no kernel-managed Python path.
    import importlib.util
    from pathlib import Path
    _source = Path(__file__).resolve().parents[4] / "python-runtime/_linux_memory.py"
    _spec = importlib.util.spec_from_file_location("_linux_memory", _source)
    _shared = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_shared)

collect = _shared.collect
_collect = _shared._collect
_Reader = _shared._Reader
_placement = _shared._placement
_meminfo = _shared._meminfo
_pressure = _shared._pressure
