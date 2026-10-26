"""Deterministic numeric policy, metadata and advice controls."""
import io
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"python-runtime"))
import _cold_residency as cold

class ColdPolicy(unittest.TestCase):
    def sample(self):
        return {"estimated_available_bytes":cold.PRESSURE_HEADROOM-1,"estimated_before_high_bytes":cold.PRESSURE_HEADROOM-1,
                "host":{"swap_free_bytes":4*cold.MAX_PASS_BYTES,"pressure":{"full":{"avg10":0}}},
                "cgroup":{"swap_current_bytes":0,"swap_max_bytes":2*cold.MAX_PASS_BYTES,"swap_max_unlimited":False}}
    def test_pressure_swap_and_unknown_inputs(self):
        import _linux_memory
        sample=self.sample()
        with patch.object(_linux_memory,"collect",return_value=sample):
            self.assertEqual(cold.pressure_budget(),("eligible",cold.MAX_PASS_BYTES))
            sample["estimated_available_bytes"]=cold.PRESSURE_HEADROOM+1
            sample["estimated_before_high_bytes"]=cold.PRESSURE_HEADROOM+1
            self.assertEqual(cold.pressure_budget(),("no-pressure",0))
            sample["estimated_available_bytes"]=None
            self.assertEqual(cold.pressure_budget(),("unavailable",0))
            sample["estimated_available_bytes"]=1
            sample["host"]["swap_free_bytes"]=cold.SWAP_RESERVE
            self.assertEqual(cold.pressure_budget(),("no-swap",0))
            sample["host"]["swap_free_bytes"]=4*cold.MAX_PASS_BYTES
            sample["cgroup"]["swap_max_unlimited"]=None
            self.assertEqual(cold.pressure_budget(),("unavailable",0))
    def test_warm_unknown_and_small_never_scan_or_advise(self):
        for reason in ("no-pressure","no-swap","unavailable"):
            with patch.object(cold,"pressure_budget",return_value=(reason,0)),patch.object(cold,"process_memory",return_value={"Rss":1,"Anonymous":0,"Swap":0}),patch.object(cold,"regions",side_effect=AssertionError("unneeded mapping scan")):
                self.assertEqual(cold.ColdResidency().step("a","mark")["state"],reason)
    def test_chunks_bounds_cold_grace_and_hot_locked_revalidation(self):
        region={"start":4096,"end":4096+6*cold.CHUNK_BYTES,"rss":6*cold.CHUNK_BYTES,"referenced":0,"locked":0}
        calls=[]
        def advice(address,size,kind): calls.append((size,kind));return 0
        fake=SimpleNamespace(madvise=advice)
        with patch.object(cold,"pressure_budget",return_value=("eligible",cold.MAX_PASS_BYTES)),patch.object(cold,"process_memory",return_value={"Rss":cold.MIN_ANON_RSS,"Anonymous":cold.MIN_ANON_RSS,"Swap":0}),patch.object(cold,"regions",return_value=[region]),patch.object(cold.ctypes,"CDLL",return_value=fake):
            owner=cold.ColdResidency()
            result=owner.step("a","mark")
            self.assertEqual(result["state"],"mark")
            self.assertLessEqual(sum(size for size,_ in calls),cold.STEP_BYTES)
            result=owner.step("a","mark")
            self.assertEqual(result["state"],"waiting")
            self.assertGreaterEqual(result["maxStepDurationNs"], result["maxAdviceDurationNs"])
            self.assertGreaterEqual(result["totalDurationNs"], result["durationNs"])
            self.assertTrue(all(kind==cold.MADV_COLD for _,kind in calls))
            region["referenced"]=4096
            result=owner.step("a","pageout")
            self.assertEqual(result["state"],"hot")
            self.assertEqual(result["pageoutBytes"],0)
            self.assertTrue(all(size<=cold.CHUNK_BYTES for size,_ in calls))
            region["referenced"],region["locked"]=0,4096
            self.assertEqual(cold.ColdResidency().step("b","mark")["state"],"unreclaimable")
    def test_later_pageout_batches_revalidate_hot_replaced_and_locked_ranges(self):
        for change in ("hot","replaced","locked"):
            region={"start":4096,"end":4096+6*cold.CHUNK_BYTES,"rss":6*cold.CHUNK_BYTES,"referenced":0,"locked":0}
            calls=[]
            def advice(address,size,kind):calls.append((size,kind));return 0
            with patch.object(cold,"pressure_budget",return_value=("eligible",cold.MAX_PASS_BYTES)),patch.object(cold,"process_memory",return_value={"Rss":cold.MIN_ANON_RSS,"Anonymous":cold.MIN_ANON_RSS,"Swap":0}),patch.object(cold,"regions",side_effect=lambda:[dict(region)]),patch.object(cold.ctypes,"CDLL",return_value=SimpleNamespace(madvise=advice)):
                owner=cold.ColdResidency()
                while owner.step("a","mark")["state"]=="mark":pass
                first=owner.step("a","pageout")
                self.assertEqual(first["state"],"pageout")
                self.assertEqual(first["pageoutBytes"],cold.STEP_BYTES)
                if change=="hot":region["referenced"]=4096
                elif change=="locked":region["locked"]=4096
                else:region["start"]+=4096;region["end"]+=4096
                last=owner.step("a","pageout")
                self.assertEqual(last["state"],"complete")
                self.assertEqual(last["pageoutBytes"],cold.STEP_BYTES,change)

    def test_mark_batches_do_not_adopt_a_replaced_mapping(self):
        region={"start":4096,"end":4096+6*cold.CHUNK_BYTES,"rss":6*cold.CHUNK_BYTES,"referenced":0,"locked":0}
        calls=[]
        def advice(address,size,kind):calls.append((size,kind));return 0
        with patch.object(cold,"pressure_budget",return_value=("eligible",cold.MAX_PASS_BYTES)),patch.object(cold,"process_memory",return_value={"Rss":cold.MIN_ANON_RSS,"Anonymous":cold.MIN_ANON_RSS,"Swap":0}),patch.object(cold,"regions",side_effect=lambda:[dict(region)]),patch.object(cold.ctypes,"CDLL",return_value=SimpleNamespace(madvise=advice)):
            owner=cold.ColdResidency()
            self.assertEqual(owner.step("a","mark")["state"],"mark")
            region["start"]+=4096;region["end"]+=4096
            self.assertEqual(owner.step("a","mark")["state"],"unreclaimable")
            self.assertTrue(all(kind==cold.MADV_COLD for _,kind in calls))
            self.assertEqual(sum(size for size,_ in calls),cold.STEP_BYTES)

    def test_absent_psi_does_not_throw_and_unknown_required_capacity_still_skips(self):
        import _linux_memory
        sample=self.sample()
        for pressure in (None,{}, {"full":None}, {"full":{}}, {"full":{"avg10":None}}):
            sample["host"]["pressure"]=pressure
            with patch.object(_linux_memory,"collect",return_value=sample):
                self.assertEqual(cold.pressure_budget()[0],"eligible")
                sample["estimated_available_bytes"]=None
                self.assertEqual(cold.pressure_budget(),("unavailable",0))
                sample["estimated_available_bytes"]=cold.PRESSURE_HEADROOM-1

    def test_only_private_anonymous_numeric_metadata_and_bounded_reads(self):
        text="""1000-3000 rw-p 00000000 00:00 0
Rss: 8 kB
Referenced: 0 kB
Locked: 0 kB
4000-6000 rw-s 00000000 00:00 0
Rss: 8 kB
Referenced: 0 kB
Locked: 0 kB
7000-9000 rw-p 00000000 00:01 1 /file
Rss: 8 kB
Referenced: 0 kB
Locked: 0 kB
"""
        with patch("builtins.open",return_value=io.BytesIO(text.replace("/file","/fïle").encode("utf-8"))):
            self.assertEqual(cold.regions(),[{"start":4096,"end":12288,"rss":8192,"referenced":0,"locked":0}])
        with patch("builtins.open",return_value=io.BytesIO(b"x"*4097)):
            with self.assertRaises(ValueError):cold.regions()
    def test_unsupported_advice_and_missing_metadata_preserve_optional_failure(self):
        region={"start":4096,"end":8192,"rss":4096,"referenced":0,"locked":0}
        def advice(*args):cold.ctypes.set_errno(22);return -1
        with patch.object(cold,"pressure_budget",return_value=("eligible",cold.MAX_PASS_BYTES)),patch.object(cold,"process_memory",return_value={"Rss":cold.MIN_ANON_RSS,"Anonymous":cold.MIN_ANON_RSS,"Swap":0}),patch.object(cold,"regions",return_value=[region]),patch.object(cold.ctypes,"CDLL",return_value=SimpleNamespace(madvise=advice)):
            result=cold.ColdResidency().step("a","mark")
            self.assertEqual(result["state"],"unsupported")
            self.assertEqual(result["pageoutBytes"],0)
        with patch.object(cold,"pressure_budget",side_effect=OSError("fixture")):
            self.assertEqual(cold.ColdResidency().step("a","mark")["state"],"unavailable")

if __name__=="__main__":unittest.main()
