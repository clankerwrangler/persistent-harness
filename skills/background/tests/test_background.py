import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
import harness_background as bg


def _proc_stat(pid):
    text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    close = text.rfind(")")
    fields = text[close + 2 :].strip().split()
    return int(fields[2]), int(fields[3]), fields[19]


def _alive(pid):
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
        close = text.rfind(")")
        state = text[close + 2 :].strip().split()[0]
        if state == "Z":
            try:
                os.waitpid(pid, os.WNOHANG)
            except OSError:
                pass
            return False
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class BackgroundTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Path(self.temp.name) / "background-jobs"
        self.store_patch = patch.object(bg, "STORE_ROOT", self.store)
        self.store_patch.start()
        self.env_patch = patch.dict(os.environ, {"PI_HARNESS_ACTOR_ID": "", "PI_HARNESS_SOCKET": ""})
        self.env_patch.start()
        self.tracked = []

    def tearDown(self):
        for item in list(self.tracked):
            self._kill_item(item)
        try:
            if self.store.is_dir():
                for name in os.listdir(self.store):
                    meta_path = self.store / name / "meta.json"
                    if not meta_path.is_file():
                        continue
                    try:
                        meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    self._kill_item(meta)
        except OSError:
            pass
        self.store_patch.stop()
        self.env_patch.stop()
        self.temp.cleanup()

    def _kill_item(self, item):
        pid = item.get("pid") if isinstance(item, dict) else None
        kind = item.get("kind") if isinstance(item, dict) else None
        starttime = item.get("starttime") if isinstance(item, dict) else None
        if not isinstance(pid, int) or pid <= 0:
            return
        try:
            pgid, _session, current = _proc_stat(pid)
        except (OSError, ValueError, IndexError):
            return
        if starttime and current != starttime:
            return
        try:
            if kind == "launched" or pgid == pid:
                os.killpg(pid, signal.SIGKILL)
            else:
                os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.waitpid(pid, os.WNOHANG)
        except OSError:
            pass

    def _track(self, result):
        if isinstance(result, dict) and result.get("ok") and result.get("pid"):
            self.tracked.append(
                {
                    "pid": result["pid"],
                    "kind": result.get("kind"),
                    "starttime": None,
                }
            )
            try:
                _pgid, _session, starttime = _proc_stat(result["pid"])
                self.tracked[-1]["starttime"] = starttime
            except (OSError, ValueError, IndexError):
                pass
        return result

    def op(self, operation, **kwargs):
        result = bg._execute_operation(operation=operation, **kwargs)
        self._track(result)
        return result

    def test_launch_true_false_printf_wait_exit_and_logs(self):
        true_job = self.op("launch", command="true", name="true-job")
        self.assertTrue(true_job["ok"], true_job)
        waited = self.op("wait", selector=true_job["id"], timeout=5)
        self.assertTrue(waited["ok"], waited)
        self.assertEqual(waited["exit_code"], 0)
        self.assertFalse(waited["running"])
        self.assertEqual(waited["state"], "exited")

        false_job = self.op("launch", command="false", name="false-job")
        waited = self.op("wait", selector=false_job["id"], timeout=5)
        self.assertTrue(waited["ok"], waited)
        self.assertEqual(waited["exit_code"], 1)
        self.assertEqual(waited["state"], "exited")

        printf_job = self.op("launch", command="printf 'ok-output\\n'", name="printf-job")
        waited = self.op("wait", selector=printf_job["id"], timeout=5)
        self.assertTrue(waited["ok"], waited)
        self.assertEqual(waited["exit_code"], 0)
        logs = self.op("logs", selector=printf_job["id"])
        self.assertTrue(logs["ok"], logs)
        self.assertIn("ok-output", logs["log"])

    def test_launch_sleep_returns_running_then_stop(self):
        started = time.monotonic()
        job = self.op("launch", command="sleep 30", name="sleep-job")
        elapsed = time.monotonic() - started
        self.assertTrue(job["ok"], job)
        self.assertLess(elapsed, 2.0)
        self.assertEqual(job["state"], "running")
        self.assertTrue(job["running"])
        status = self.op("status", selector="sleep-job")
        self.assertEqual(status["state"], "running")
        pid = job["pid"]
        self.assertTrue(_alive(pid))
        stopped = self.op("stop", selector=job["id"])
        self.assertTrue(stopped["ok"], stopped)
        self.assertFalse(stopped["running"])
        self.assertNotEqual(stopped["state"], "running")
        self.assertIn(stopped["signal"], {"SIGTERM", "SIGKILL"})
        self.assertFalse(_alive(pid))
        again = self.op("stop", selector=job["id"])
        self.assertFalse(again["ok"])
        self.assertEqual(again["error"], "NOT_RUNNING")

    def test_job_is_session_leader_and_survives_without_wait(self):
        job = self.op("launch", command="sleep 30", name="session-job")
        self.assertTrue(job["ok"], job)
        pid = job["pid"]
        pgid, session, _start = _proc_stat(pid)
        self.assertEqual(pgid, pid)
        self.assertEqual(session, pid)
        self.assertNotEqual(os.getpgid(pid), os.getpgrp())
        time.sleep(0.2)
        self.assertTrue(_alive(pid))
        self.assertEqual(self.op("status", selector=job["id"])["state"], "running")

    def test_adopt_local_sleep_status_and_stop(self):
        proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
        self.tracked.append({"pid": proc.pid, "kind": "adopted", "starttime": _proc_stat(proc.pid)[2]})
        proc.returncode = 0
        adopted = self.op("adopt", pid=proc.pid, name="adopted-sleep")
        self.assertTrue(adopted["ok"], adopted)
        self.assertEqual(adopted["kind"], "adopted")
        self.assertEqual(adopted["state"], "running")
        status = self.op("status", selector="adopted-sleep")
        self.assertEqual(status["state"], "running")
        stopped = self.op("stop", selector="adopted-sleep")
        self.assertTrue(stopped["ok"], stopped)
        self.assertFalse(stopped["running"])
        self.assertFalse(_alive(proc.pid))

    def test_adopt_status_ignores_reused_pid_with_different_starttime(self):
        proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
        self.tracked.append({"pid": proc.pid, "kind": "adopted", "starttime": _proc_stat(proc.pid)[2]})
        proc.returncode = 0
        adopted = self.op("adopt", pid=proc.pid, name="reuse-job")
        self.assertTrue(adopted["ok"], adopted)
        meta_path = self.store / adopted["id"] / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["starttime"] = "1"
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
        status = self.op("status", selector=adopted["id"])
        self.assertTrue(status["ok"], status)
        self.assertNotEqual(status["state"], "running")
        self.assertFalse(status["running"])
        self.op("stop", selector=adopted["id"])
        self.assertTrue(_alive(proc.pid))

    def test_logs_bound_and_invalid_utf8(self):
        job = self.op("launch", command="true", name="log-job")
        waited = self.op("wait", selector=job["id"], timeout=5)
        self.assertTrue(waited["ok"], waited)
        path = Path(waited["log_path"])
        path.write_bytes(b"A" * 1000 + b"\xff\xfe" + b"TAILTAIL")
        logs = self.op("logs", selector=job["id"], tail_bytes=8)
        self.assertTrue(logs["ok"], logs)
        self.assertTrue(logs["truncated"])
        self.assertIn("TAIL", logs["log"])
        self.assertGreater(logs["log_bytes"], 8)
        # replacement decode must not crash
        bigger = self.op("logs", selector=job["id"], tail_bytes=20)
        self.assertTrue(bigger["ok"], bigger)
        self.assertIn("\ufffd", bigger["log"])

    def test_launch_records_owner_session_for_supervisor_delivery(self):
        with patch.dict(os.environ, {"PI_HARNESS_ACTOR_ID": "session-test"}):
            job = self.op("launch", command="true", name="notify-job")
            meta_path = self.store / job["id"] / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            waited = self.op("wait", selector=job["id"], timeout=5)
        self.assertEqual(meta["session_id"], "session-test")
        self.assertNotIn("socket_path", meta)
        self.assertEqual(waited["exit_code"], 0)

    def test_invalid_arguments_and_bounds(self):
        self.assertEqual(self.op("nope")["error"], "INVALID_OPERATION")
        self.assertEqual(self.op("launch")["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("launch", command="")["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("adopt", pid=True)["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("status", selector="")["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("status", selector="missing-name")["error"], "NOT_FOUND")
        self.assertEqual(self.op("wait", selector="missing-name", timeout=0)["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("wait", selector="missing-name", timeout=31)["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("wait", selector="missing-name", timeout=True)["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("logs", selector="missing-name", tail_bytes=True)["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("logs", selector="missing-name", tail_bytes=0)["error"], "INVALID_ARGUMENT")
        self.assertEqual(self.op("logs", selector="missing-name", tail_bytes=65537)["error"], "INVALID_ARGUMENT")
        self.assertEqual(
            asyncio.run(bg.run(operation="launch", command="true", extra=1))["error"],
            "INVALID_ARGUMENT",
        )
        self.assertEqual(asyncio.run(bg.run(operation="bogus"))["error"], "INVALID_OPERATION")

    def test_live_name_uniqueness(self):
        first = self.op("launch", command="sleep 30", name="SameName")
        self.assertTrue(first["ok"], first)
        second = self.op("launch", command="sleep 30", name="SameName")
        self.assertEqual(second["error"], "INVALID_ARGUMENT")
        third = self.op("launch", command="sleep 30", name="samename")
        self.assertEqual(third["error"], "INVALID_ARGUMENT")

    def test_remove_refuses_while_running_unless_force(self):
        job = self.op("launch", command="sleep 30", name="remove-job")
        self.assertTrue(job["ok"], job)
        refused = self.op("remove", selector="remove-job")
        self.assertEqual(refused["error"], "STILL_RUNNING")
        self.assertEqual(self.op("status", selector="remove-job")["state"], "running")
        removed = self.op("remove", selector="remove-job", force=True)
        self.assertTrue(removed["ok"], removed)
        self.assertEqual(self.op("status", selector=job["id"])["error"], "NOT_FOUND")

    def test_list_include_exited(self):
        running = self.op("launch", command="sleep 30", name="list-run")
        self.assertTrue(running["ok"], running)
        done = self.op("launch", command="true", name="list-done")
        waited = self.op("wait", selector=done["id"], timeout=5)
        self.assertEqual(waited["state"], "exited")
        listed = self.op("list")
        self.assertTrue(listed["ok"], listed)
        names = {job["name"] for job in listed["jobs"]}
        self.assertIn("list-run", names)
        self.assertNotIn("list-done", names)
        self.assertFalse(listed["truncated"])
        all_jobs = self.op("list", include_exited=True)
        names = {job["name"] for job in all_jobs["jobs"]}
        self.assertIn("list-run", names)
        self.assertIn("list-done", names)

    def test_limit_exceeded_when_max_running_is_one(self):
        with patch.object(bg, "MAX_RUNNING_JOBS", 1):
            first = self.op("launch", command="sleep 30", name="limit-one")
            self.assertTrue(first["ok"], first)
            second = self.op("launch", command="sleep 30", name="limit-two")
            self.assertEqual(second["error"], "LIMIT_EXCEEDED")

    def test_command_with_spaces_and_quotes(self):
        job = self.op("launch", command='printf "hello world"', name="quotes-job")
        waited = self.op("wait", selector=job["id"], timeout=5)
        self.assertTrue(waited["ok"], waited)
        self.assertEqual(waited["exit_code"], 0)
        logs = self.op("logs", selector=job["id"])
        self.assertIn("hello world", logs["log"])


if __name__ == "__main__":
    unittest.main()
