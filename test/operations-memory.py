"""Pure-stdlib fixtures for the local operations.memory observer."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "skills/operations/src/harness_operations/_memory.py"
spec = importlib.util.spec_from_file_location("operations_memory_fixture", MODULE)
memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory)


class Fixture:
    def __init__(self, member="/", mount_root="/", mount="/cg"):
        self.mount = mount
        self.leaf = mount + member.removeprefix(mount_root).rstrip("/") if mount_root != "/" else mount + member.rstrip("/")
        self.data = {
            "/proc/meminfo": "MemTotal: 100 kB\nMemAvailable: 20 kB\nSwapTotal: 80 kB\nSwapFree: 60 kB\n",
            "/proc/pressure/memory": self.psi(),
            "/proc/self/cgroup": f"0::{member}\n",
            "/proc/self/mountinfo": f"1 0 0:1 {mount_root} {mount} rw - cgroup2 cgroup rw\n",
        }
        p = Path(self.leaf)
        while True:
            self.level(str(p))
            if str(p) == mount:
                break
            p = p.parent
        self.data[self.leaf + "/memory.stat"] = "anon 5000\nfile 4000\ninactive_file 3500\nkernel 500\nshmem 100\nfile_dirty 200\nfile_writeback 50\n"
        self.data[self.leaf + "/memory.swap.current"] = "3000\n"
        self.data[self.leaf + "/memory.swap.max"] = "max\n"
        self.reads = []

    @staticmethod
    def psi():
        return "some avg10=0.01 avg60=0.02 avg300=0.03 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.01 total=10\n"

    def level(self, p, current="9000", cap="10000", high="max"):
        self.data[p + "/memory.current"] = current
        self.data[p + "/memory.max"] = cap
        self.data[p + "/memory.high"] = high
        self.data[p + "/memory.events"] = "low 1\nhigh 2\nmax 3\noom 4\noom_kill 5\noom_group_kill 6\n"
        self.data[p + "/memory.pressure"] = self.psi()

    def read(self, path, limit):
        self.reads.append((path, limit))
        value = self.data.get(path)
        return value if value is None or len(value) <= limit else None

    def collect(self):
        return memory._collect(self.read)


class Accounting(unittest.TestCase):
    def test_separates_raw_charge_cache_swap_and_pressure(self):
        f = Fixture()
        r = f.collect()
        self.assertTrue(r["hierarchy_complete"])
        self.assertEqual(r["scope"], "visible_cgroup_v2_hierarchy")
        self.assertEqual(r["hierarchy"][0]["raw_max_headroom_bytes"], 1000)
        self.assertEqual(r["cgroup"]["clean_inactive_file_estimate_bytes"], 3150)
        self.assertEqual(r["estimated_available_bytes"], 4150)
        self.assertEqual(r["estimated_before_high_bytes"], 4150)
        self.assertEqual(r["cgroup"]["anon_bytes"], 5000)
        self.assertEqual(r["cgroup"]["kernel_bytes"], 500)
        self.assertEqual(r["cgroup"]["swap_current_bytes"], 3000)
        self.assertTrue(r["cgroup"]["swap_max_unlimited"])
        self.assertEqual(r["hierarchy"][0]["events"]["oom_kill"], 5)
        self.assertEqual(r["hierarchy"][0]["pressure"]["some"]["avg10"], .01)
        self.assertNotIn("/proc/1/cmdline", [p for p, _ in f.reads])
        self.assertTrue(all(p.startswith(("/proc/", "/cg/")) for p, _ in f.reads))

    def test_anon_and_swap_never_add_capacity(self):
        f = Fixture()
        f.data[f.leaf + "/memory.stat"] = f.data[f.leaf + "/memory.stat"].replace("anon 5000", "anon 9000000000")
        f.data[f.leaf + "/memory.swap.current"] = "9000000000"
        self.assertEqual(f.collect()["estimated_available_bytes"], 4150)
        f.data[f.leaf + "/memory.stat"] = f.data[f.leaf + "/memory.stat"].replace("shmem 100", "shmem 9999")
        self.assertEqual(f.collect()["estimated_available_bytes"], 1000)

    def test_ceiling_debt_is_paid_before_cache_credit(self):
        f = Fixture()
        f.data["/cg/memory.current"] = "12000"
        r = f.collect()
        self.assertEqual(r["hierarchy"][0]["raw_max_headroom_bytes"], -2000)
        self.assertEqual(r["estimated_available_bytes"], 1150)
        f.data["/cg/memory.current"] = "20000"
        self.assertEqual(f.collect()["estimated_available_bytes"], 0)

    def test_leaf_credit_cannot_exceed_sampled_charge(self):
        f = Fixture()
        f.data["/cg/memory.current"] = "1"
        self.assertEqual(f.collect()["estimated_available_bytes"], 10000)

    def test_host_ancestor_max_and_high_are_distinct_bounds(self):
        f = Fixture("/parent/leaf")
        f.level("/cg/parent", "12000", "13000", "12500")
        f.level("/cg", "20000", "max", "max")
        r = f.collect()
        self.assertEqual(len(r["hierarchy"]), 3)
        self.assertEqual(r["estimated_available_bytes"], 4150)
        self.assertEqual(r["estimated_before_high_bytes"], 3650)
        f.data["/proc/meminfo"] = "MemTotal: 100 kB\nMemAvailable: 1 kB\n"
        self.assertEqual(f.collect()["estimated_available_bytes"], 1024)
        f.data["/proc/meminfo"] = "MemTotal: 100 kB\nMemAvailable: 20 kB\n"
        f.data["/cg/parent/memory.max"] = "11000"
        self.assertEqual(f.collect()["estimated_available_bytes"], 2150)
        # No ancestor stat (and therefore no sibling cache) is read.
        self.assertNotIn(("/cg/parent/memory.stat", 16384), f.reads)

    def test_unlimited_is_not_unknown(self):
        f = Fixture()
        f.data["/cg/memory.max"] = "max"
        r = f.collect()
        self.assertEqual(r["estimated_available_bytes"], 20480)
        self.assertIsNone(r["hierarchy"][0]["raw_max_headroom_bytes"])
        del f.data["/cg/memory.max"]
        r = f.collect()
        self.assertIsNone(r["hierarchy"][0]["max_unlimited"])
        self.assertIsNone(r["estimated_available_bytes"])

    def test_required_inputs_fail_closed(self):
        for path, value in [("/cg/memory.current", None), ("/cg/memory.max", "-1"),
                            ("/cg/memory.max", str(1 << 64)), ("/proc/meminfo", "MemAvailable: bad kB"),
                            ("/proc/meminfo", "MemAvailable 20 kB"),
                            ("/cg/memory.stat", "file 1\ninactive_file 1\n"),
                            ("/cg/memory.stat", "file 1\nfile 1\n")]:
            with self.subTest(path=path, value=value):
                f = Fixture()
                f.data[path] = value
                self.assertIsNone(f.collect()["estimated_available_bytes"])
        f = Fixture()
        f.data["/cg/memory.high"] = "bad"
        r = f.collect()
        self.assertEqual(r["estimated_available_bytes"], 4150)
        self.assertIsNone(r["estimated_before_high_bytes"])
        f = Fixture("/parent/leaf")
        del f.data["/cg/memory.current"]
        self.assertIsNone(f.collect()["estimated_available_bytes"])
        f = Fixture()
        f.data["/proc/meminfo"] = "MemTotal: 1 kB\nMemAvailable: 2 kB\n"
        self.assertIsNone(f.collect()["estimated_available_bytes"])

    def test_pressure_and_events_unknown_are_not_zero(self):
        f = Fixture()
        f.data["/cg/memory.pressure"] = "some avg10=nan avg60=inf avg300=-1 total=bad"
        f.data["/cg/memory.events"] = None
        r = f.collect()
        self.assertTrue(all(v is None for v in r["hierarchy"][0]["pressure"]["some"].values()))
        self.assertTrue(all(v is None for v in r["hierarchy"][0]["events"].values()))
        self.assertEqual(memory._pressure("some avg10=1 avg10=2")["some"]["avg10"], None)
        self.assertEqual(memory._meminfo("MemAvailable: 1 kB\nMemAvailable: 2 kB")["available_bytes"], None)

    def test_topology_placement_bounds_and_changes(self):
        f = Fixture("/tenant/leaf", "/tenant")
        self.assertEqual(f.collect()["estimated_available_bytes"], 4150)
        self.assertEqual(memory._placement("0::/tenant/leaf\n", "1 0 0:1 /tenant /cg\\040space rw - cgroup2 cgroup rw\n"),
                         (Path("/cg space"), Path("/cg space/leaf")))
        mounts = "1 0 0:1 /tenant /narrow rw - cgroup2 cgroup rw\n2 0 0:1 / /inclusive rw - cgroup2 cgroup rw\n"
        self.assertEqual(str(memory._placement("0::/tenant/leaf", mounts)[0]), "/inclusive")
        for membership in (None, "1:memory:/\n", "0::/../../escape", "0::/\n0::/\n"):
            f = Fixture()
            f.data["/proc/self/cgroup"] = membership
            r = f.collect()
            self.assertFalse(r["hierarchy_complete"])
            self.assertIsNone(r["estimated_available_bytes"])
        f = Fixture()
        original = f.read
        count = 0
        def changed(path, limit):
            nonlocal count
            if path == "/proc/self/cgroup":
                count += 1
                if count == 2:
                    return "0::/moved"
            return original(path, limit)
        self.assertFalse(memory._collect(changed)["hierarchy_complete"])
        f = Fixture("/" + "/".join(["a"] * 33))
        r = f.collect()
        self.assertEqual(len(r["hierarchy"]), 32)
        self.assertFalse(r["hierarchy_complete"])
        self.assertIsNone(r["estimated_available_bytes"])
        self.assertLess(len(f.reads), 180)

    def test_reader_bounds_invalid_bytes_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "value"
            p.write_bytes(b"12345")
            self.assertIsNone(memory._Reader()(str(p), 4))
            p.write_bytes(b"\xff")
            self.assertIsNone(memory._Reader()(str(p), 4))
            link = Path(tmp) / "link"
            link.symlink_to(p)
            self.assertIsNone(memory._Reader()(str(link), 4))
            reader = memory._Reader()
            reader.remaining = 1
            self.assertIsNone(reader(str(p), 4))

    def test_public_api_is_argument_free_local_and_preserves_existing_methods(self):
        host_calls = []
        stub = types.ModuleType("_persistent_harness")
        stub.SkillResult = dict
        stub.host_request = lambda name, payload: host_calls.append((name, payload)) or {"ok": True}
        module_spec = importlib.util.spec_from_file_location("harness_operations_fixture", MODULE.parent / "__init__.py",
                                                           submodule_search_locations=[str(MODULE.parent)])
        package = importlib.util.module_from_spec(module_spec)
        with patch.dict(sys.modules, {"_persistent_harness": stub, "harness_operations_fixture": package}):
            module_spec.loader.exec_module(package)
            with patch("harness_operations_fixture._memory.collect", return_value={"schema_version": 1}):
                self.assertEqual(package.memory(), {"schema_version": 1})
            self.assertEqual(host_calls, [])
            with self.assertRaises(TypeError):
                package.memory("/arbitrary")
            package.status(); package.diagnose(); package.usage(5); package.events(8)
        self.assertEqual(host_calls, [("operations.status", {}), ("operations.diagnose", {}),
                                     ("operations.usage", {"windowMinutes": 5}), ("operations.events", {"limit": 8})])


if __name__ == "__main__":
    unittest.main()
