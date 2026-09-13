from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import io
import json
import math
import os
import re
import shutil
import stat
import sys
import tempfile
import time
import traceback
import types
from pathlib import Path

import dill
from IPython.core import page as ipython_page
from IPython.core.interactiveshell import InteractiveShell
from IPython.core.displayhook import DisplayHook
from IPython.core.formatters import BaseFormatter, DisplayFormatter
from IPython.core.displaypub import DisplayPublisher
from IPython.core.history import HistoryOutput

from _persistent_harness import SkillProxy, bootstrap_skills, configure_control

PROTOCOL_VERSION = 1
SNAPSHOT_VERSION = 1
PER_VARIABLE_LIMIT = 4 * 1024 * 1024
TOTAL_SNAPSHOT_LIMIT = 16 * 1024 * 1024
MANIFEST_LIMIT = 1024 * 1024

parser = argparse.ArgumentParser()
parser.add_argument("--config", required=True)
args = parser.parse_args()
config = json.loads(Path(args.config).read_text("utf-8"))
control = os.fdopen(3, "r+b", buffering=0)
configure_control(control)
active_output_id = None
max_output_frame_bytes = config.get("maxOutputFrameBytes", 1024 * 1024)


def emit(frame):
    payload = (json.dumps(frame, separators=(",", ":"), default=str, allow_nan=False) + "\n").encode("utf-8")
    if frame.get("type") == "result" and len(payload) - 1 > max_output_frame_bytes:
        notice = {"type": "result", "id": frame["id"], "mime": {}, "truncated": True}
        if "outputType" in frame:
            notice["outputType"] = frame["outputType"]
        payload = (json.dumps(notice) + "\n").encode("utf-8")
    control.write(payload)
    control.flush()


def receive():
    line = control.readline()
    if not line:
        raise EOFError("host disconnected")
    return json.loads(line)


def publish_mime(data, *, explicit=True):
    bundle = {}
    for key, value in data.items():
        if isinstance(value, (bytes, bytearray, memoryview)) and key.startswith("image/"):
            value = base64.b64encode(value).decode("ascii")
        try:
            json.dumps(value, allow_nan=False)
        except (TypeError, ValueError):
            value = repr(value)
        bundle[str(key)] = value
    if active_output_id is not None and bundle:
        frame = {"type": "result", "id": active_output_id, "mime": bundle}
        if explicit:
            frame["outputType"] = "display_data"
        emit(frame)


class ProtocolStream(io.TextIOBase):
    """Keep Python stream writes ordered with MIME on the existing control pipe."""

    def __init__(self, original, stream):
        super().__init__()
        self.original = original
        self.stream = stream

    @property
    def encoding(self):
        return self.original.encoding

    @property
    def errors(self):
        return self.original.errors

    @property
    def closed(self):
        return self.original.closed

    def fileno(self):
        return self.original.fileno()

    def writable(self):
        return self.original.writable()

    def isatty(self):
        return self.original.isatty()

    def close(self):
        self.original.close()

    def __del__(self):
        # This adapter borrows the process stream; collection must not close it.
        pass

    def __getattr__(self, name):
        return getattr(self.original, name)

    def write(self, text):
        if self.closed:
            raise ValueError("I/O operation on closed file.")
        if not isinstance(text, str):
            raise TypeError("write() argument must be str")
        if active_output_id is None:
            return self.original.write(text)
        for offset in range(0, len(text), 4096):
            emit({"type": "result", "id": active_output_id, "stream": self.stream,
                  "mime": {"text/plain": text[offset:offset + 4096]}})
        return len(text)

    def flush(self):
        self.original.flush()
        control.flush()


class ProtocolDisplayPublisher(DisplayPublisher):
    def publish(self, data, metadata=None, source=None, *, transient=None, update=False, **kwargs):
        self.shell.history_manager.outputs[self.shell.execution_count - 1].append(
            HistoryOutput(output_type="display_data", bundle=data))
        for mime, handler in getattr(self.shell, "mime_renderers", {}).items():
            if mime in data:
                handler(data[mime], (metadata or {}).get(mime))
                return
        self._is_publishing = True
        try:
            # Keep explicit display text on its existing bounded stdout path.
            # Forward the other MIME representations without printing them again.
            if "text/plain" in data:
                print(data["text/plain"])
            publish_mime({key: value for key, value in data.items() if key != "text/plain"})
        finally:
            self._is_publishing = False


class FinalTextFormatter(BaseFormatter):
    def __call__(self, value):
        return repr(value)


class ProtocolDisplayHook(DisplayHook):
    def compute_format_data(self, result):
        # The final value used complete repr before rich display capture. Keep
        # that fallback without changing explicit display or calling MIME twice.
        current = self.shell.display_formatter
        text = FinalTextFormatter()
        formatter = DisplayFormatter(
            ipython_display_formatter=current.ipython_display_formatter,
            mimebundle_formatter=current.mimebundle_formatter,
            formatters={**current.formatters, "text/plain": text})
        return formatter.format(result)

    def write_output_prompt(self):
        pass

    def write_format_data(self, format_dict, md_dict=None):
        publish_mime(format_dict, explicit=False)

    def finish_displayhook(self):
        sys.stdout.flush()
        self._is_active = False


def atomic_write_json(file_path, value, *, durable=False):
    file_path = Path(file_path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f"{file_path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
        if durable:
            stream.flush()
            os.fsync(stream.fileno())
    os.replace(temporary, file_path)


def sync_snapshot_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class SnapshotSizeLimitExceeded(Exception):
    pass


class BoundedBytesIO(io.BytesIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit

    def write(self, data):
        if len(data) > self.limit - self.tell():
            raise SnapshotSizeLimitExceeded
        return super().write(data)


def cleanup_stale_snapshot_temps(snapshot_path):
    target = Path(snapshot_path)
    parent = target.parent
    if not parent.exists():
        return {"removed": 0, "skipped": 0, "errors": []}
    current_prefix = f"{target.name}.snapshot-tmp-"
    legacy_pattern = re.compile(rf"^{re.escape(target.name)}\.[a-z0-9_]{{8}}$")
    removed = 0
    skipped = 0
    errors = []
    try:
        entries = list(parent.iterdir())
    except OSError as error:
        return {"removed": 0, "skipped": 0, "errors": [f"{type(error).__name__}: {error}"]}
    for entry in entries:
        if entry.name == f"{target.name}.previous":
            continue
        if not (entry.name.startswith(current_prefix) or legacy_pattern.fullmatch(entry.name)):
            continue
        try:
            mode = entry.lstat().st_mode
            if stat.S_ISDIR(mode):
                shutil.rmtree(entry)
                removed += 1
            elif stat.S_ISLNK(mode):
                # Remove only the stale link itself; never traverse its target.
                entry.unlink()
                removed += 1
            else:
                skipped += 1
        except FileNotFoundError:
            continue
        except OSError as error:
            errors.append(f"{entry.name}: {type(error).__name__}: {error}")
    return {"removed": removed, "skipped": skipped, "errors": errors}


def read_bounded_regular(directory_fd, file_name, *, max_bytes, expected_bytes=None, expected_hash=None):
    if not hasattr(os, "O_NOFOLLOW"):
        raise OSError(errno.ENOTSUP, "safe no-follow file access is unavailable")
    flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_NONBLOCK"):
        flags |= getattr(os, flag_name, 0)
    try:
        descriptor = os.open(file_name, flags, dir_fd=directory_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENXIO):
            raise ValueError("not a non-symlink regular file") from error
        raise
    try:
        file_stat = os.fstat(descriptor)
        if not stat.S_ISREG(file_stat.st_mode):
            raise ValueError("not a non-symlink regular file")
        if file_stat.st_size > max_bytes:
            raise ValueError(f"file exceeds {max_bytes} byte limit")
        if expected_bytes is not None and file_stat.st_size != expected_bytes:
            raise ValueError(f"size mismatch: expected {expected_bytes}, found {file_stat.st_size}")
        read_limit = max_bytes if expected_bytes is None else expected_bytes
        payload = bytearray()
        while len(payload) < read_limit:
            chunk = os.read(descriptor, min(1024 * 1024, read_limit - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        if os.read(descriptor, 1):
            raise ValueError(f"file exceeds {read_limit} byte read limit")
        if expected_bytes is not None and len(payload) != expected_bytes:
            raise ValueError(f"size mismatch: expected {expected_bytes}, read {len(payload)}")
        payload = bytes(payload)
        if expected_hash is not None and hashlib.sha256(payload).hexdigest() != expected_hash:
            raise ValueError("checksum mismatch")
        return payload
    finally:
        os.close(descriptor)


def reject_duplicate_json_members(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON member: {key}")
        value[key] = item
    return value


def reject_nonfinite_json_number(token):
    raise ValueError(f"non-finite JSON number: {token}")


def exact_blob_attribution_possible(byte_counts, blob_count, byte_count):
    """Return whether exactly blob_count entries can account for byte_count bytes.

    Snapshot stats do not identify which entries were reused.  Exact cardinality
    subset-sum is therefore the canonical consistency check.  The bounded work
    guard fails closed rather than accepting metadata whose attribution was not
    proved.
    """
    entry_count = len(byte_counts)
    if blob_count < 0 or blob_count > entry_count or byte_count < 0:
        return False
    if blob_count == 0:
        return byte_count == 0
    if blob_count == entry_count:
        return byte_count == sum(byte_counts)

    # Prove the smaller side; its complement proves the requested side.
    if blob_count > entry_count - blob_count:
        blob_count = entry_count - blob_count
        byte_count = sum(byte_counts) - byte_count
    ordered = sorted(byte_counts)
    if byte_count < sum(ordered[:blob_count]) or byte_count > sum(ordered[-blob_count:]):
        return False

    # Bit c of the array is a bitset of byte totals reachable with c entries.
    # Keep both CPU and memory bounded for hostile one-megabyte manifests.
    if entry_count * blob_count > 250_000 or (blob_count + 1) * (byte_count + 1) > 64_000_000:
        return False
    mask = (1 << (byte_count + 1)) - 1
    reachable = [0] * (blob_count + 1)
    reachable[0] = 1
    for index, amount in enumerate(byte_counts):
        for count in range(min(blob_count, index + 1), 0, -1):
            reachable[count] |= (reachable[count - 1] << amount) & mask
        if (reachable[blob_count] >> byte_count) & 1:
            return True
    return False


def exact_keys(value, *, required, optional=frozenset()):
    keys = set(value)
    missing = required - keys
    unknown = keys - required - optional
    if missing:
        return f"missing keys: {', '.join(sorted(missing))}"
    if unknown:
        return f"unknown keys: {', '.join(sorted(unknown))}"
    return None


def non_negative_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def valid_namespace_checkpoint(checkpoint):
    return (
        isinstance(checkpoint, dict)
        and exact_keys(checkpoint, required={
            "version", "sessionId", "toolCallId", "actorGeneration", "executionId",
        }) is None
        and type(checkpoint["version"]) is int
        and checkpoint["version"] == 1
        and all(isinstance(checkpoint[key], str) and checkpoint[key]
                for key in ("sessionId", "toolCallId", "executionId"))
        and non_negative_integer(checkpoint["actorGeneration"])
        and checkpoint["actorGeneration"] > 0
    )


def validate_snapshot_directory(snapshot_path, *, load_payloads=False):
    target = Path(snapshot_path)
    if not hasattr(os, "O_NOFOLLOW"):
        return {
            "found": target.exists(),
            "manifest": None,
            "entries": [],
            "skipped": [],
            "errors": [{"name": "*", "reason": "safe no-follow snapshot access is unavailable"}],
            "complete": False,
        }
    directory_flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"):
        directory_flags |= getattr(os, flag_name, 0)
    try:
        directory_fd = os.open(target, directory_flags)
    except FileNotFoundError:
        return {"found": False, "manifest": None, "entries": [], "skipped": [], "errors": [], "complete": False}
    except OSError as error:
        return {
            "found": True,
            "manifest": None,
            "entries": [],
            "skipped": [],
            "errors": [{"name": "*", "reason": f"invalid snapshot directory: {type(error).__name__}: {error}"}],
            "complete": False,
        }
    try:
        if not stat.S_ISDIR(os.fstat(directory_fd).st_mode):
            raise ValueError("snapshot path is not a directory")
        try:
            manifest_payload = read_bounded_regular(directory_fd, "manifest.json", max_bytes=MANIFEST_LIMIT)
            manifest = json.loads(
                manifest_payload.decode("utf-8"),
                object_pairs_hook=reject_duplicate_json_members,
                parse_constant=reject_nonfinite_json_number,
            )
        except Exception as error:
            return {
                "found": True,
                "manifest": None,
                "entries": [],
                "skipped": [],
                "errors": [{"name": "*", "reason": f"invalid manifest: {type(error).__name__}: {error}"}],
                "complete": False,
            }

        manifest_error = None
        if not isinstance(manifest, dict):
            manifest_error = "manifest must be an object"
        else:
            key_error = exact_keys(
                manifest,
                required={"version", "saved"},
                optional={"skipped", "totalBytes", "stats", "namespaceCheckpoint"},
            )
            if key_error is not None:
                manifest_error = f"manifest has {key_error}"
            elif not isinstance(manifest["version"], int) or isinstance(manifest["version"], bool):
                manifest_error = "manifest version must be an integer"
            elif manifest["version"] != SNAPSHOT_VERSION:
                manifest_error = "unsupported snapshot version"
            elif not isinstance(manifest["saved"], list):
                manifest_error = "manifest saved must be an array"
            elif "skipped" in manifest and not isinstance(manifest["skipped"], list):
                manifest_error = "manifest skipped must be an array"
            elif "namespaceCheckpoint" in manifest and not valid_namespace_checkpoint(manifest["namespaceCheckpoint"]):
                manifest_error = "manifest namespaceCheckpoint is invalid"
        if manifest_error is not None:
            return {
                "found": True,
                "manifest": manifest,
                "entries": [],
                "skipped": [],
                "errors": [{"name": "*", "reason": manifest_error}],
                "complete": False,
            }

        saved_items = manifest["saved"]
        skipped_items = manifest.get("skipped", [])
        canonical_byte_counts = []
        byte_total_is_canonical = True
        for item in saved_items:
            if (
                not isinstance(item, dict)
                or exact_keys(item, required={"name", "file", "bytes", "sha256"}) is not None
                or not non_negative_integer(item.get("bytes"))
            ):
                byte_total_is_canonical = False
                break
            canonical_byte_counts.append(item["bytes"])
        declared_total = sum(canonical_byte_counts) if byte_total_is_canonical else None

        if "totalBytes" in manifest:
            total_bytes = manifest["totalBytes"]
            if not non_negative_integer(total_bytes) or total_bytes > TOTAL_SNAPSHOT_LIMIT:
                manifest_error = "manifest totalBytes is invalid"
            elif declared_total is None:
                manifest_error = "manifest totalBytes cannot be reconciled with malformed saved entries"
            elif total_bytes != declared_total:
                manifest_error = f"manifest totalBytes mismatch: declared {total_bytes}, recomputed {declared_total}"

        if manifest_error is None and "stats" in manifest:
            stats = manifest["stats"]
            stats_keys = {
                "attemptedVariables",
                "serializedVariables",
                "boundedVariables",
                "reusedBlobs",
                "reusedBytes",
                "writtenBlobs",
                "writtenBytes",
                "durationMs",
            }
            if not isinstance(stats, dict):
                manifest_error = "manifest stats must be an object"
            else:
                key_error = exact_keys(stats, required=stats_keys)
                if key_error is not None:
                    manifest_error = f"manifest stats has {key_error}"
                else:
                    integer_keys = stats_keys - {"durationMs"}
                    invalid_integer = next((key for key in sorted(integer_keys) if not non_negative_integer(stats[key])), None)
                    duration = stats["durationMs"]
                    if invalid_integer is not None:
                        manifest_error = f"manifest stats {invalid_integer} must be a non-negative integer"
                    elif (
                        not isinstance(duration, (int, float))
                        or isinstance(duration, bool)
                        or not math.isfinite(duration)
                        or duration < 0
                    ):
                        manifest_error = "manifest stats durationMs must be a finite non-negative number"
                    elif declared_total is None:
                        manifest_error = "manifest stats cannot be reconciled with malformed saved entries"
                    elif stats["attemptedVariables"] != len(saved_items) + len(skipped_items):
                        manifest_error = "manifest stats attemptedVariables mismatch"
                    elif stats["serializedVariables"] != len(saved_items):
                        manifest_error = "manifest stats serializedVariables mismatch"
                    elif stats["boundedVariables"] != sum(
                        isinstance(item, dict)
                        and item.get("reason") in {"per-variable size limit", "total snapshot size limit"}
                        for item in skipped_items
                    ):
                        manifest_error = "manifest stats boundedVariables mismatch"
                    elif stats["reusedBlobs"] + stats["writtenBlobs"] != len(saved_items):
                        manifest_error = "manifest stats blob total mismatch"
                    elif stats["reusedBytes"] + stats["writtenBytes"] != declared_total:
                        manifest_error = "manifest stats byte total mismatch"
                    elif not exact_blob_attribution_possible(
                        canonical_byte_counts,
                        stats["reusedBlobs"],
                        stats["reusedBytes"],
                    ):
                        manifest_error = "manifest stats reused/written attribution is impossible"
        if manifest_error is not None:
            return {
                "found": True,
                "manifest": manifest,
                "entries": [],
                "skipped": [],
                "errors": [{"name": "*", "reason": manifest_error}],
                "complete": False,
            }

        skipped = []
        errors = []
        skipped_item_errors = [[] for _ in skipped_items]
        skipped_name_indexes = {}
        for index, skipped_item in enumerate(skipped_items):
            if not isinstance(skipped_item, dict):
                skipped_item_errors[index].append("must be an object")
                continue
            key_error = exact_keys(skipped_item, required={"name", "reason"})
            if key_error is not None:
                skipped_item_errors[index].append(key_error)
            name = skipped_item.get("name")
            reason = skipped_item.get("reason")
            if not isinstance(name, str) or not isinstance(reason, str):
                skipped_item_errors[index].append("name and reason must be strings")
            if isinstance(name, str):
                skipped_name_indexes.setdefault(name, []).append(index)

        item_errors = [[] for _ in saved_items]
        name_indexes = {}
        file_indexes = {}
        for index, item in enumerate(saved_items):
            if not isinstance(item, dict):
                item_errors[index].append("saved entry must be an object")
                continue
            key_error = exact_keys(item, required={"name", "file", "bytes", "sha256"})
            if key_error is not None:
                item_errors[index].append(f"saved entry has {key_error}")
            name = item.get("name")
            file_name = item.get("file")
            byte_count = item.get("bytes")
            digest = item.get("sha256")
            if not isinstance(name, str):
                item_errors[index].append("name must be a string")
            else:
                name_indexes.setdefault(name, []).append(index)
            if (
                not isinstance(file_name, str)
                or not file_name
                or file_name in (".", "..")
                or "/" in file_name
                or "\\" in file_name
                or "\x00" in file_name
                or Path(file_name).name != file_name
                or Path(file_name).is_absolute()
            ):
                item_errors[index].append("file must be a safe basename")
            else:
                file_indexes.setdefault(file_name, []).append(index)
            if not non_negative_integer(byte_count):
                item_errors[index].append("bytes must be a non-negative integer")
            elif byte_count > PER_VARIABLE_LIMIT:
                item_errors[index].append("declared size exceeds per-variable limit")
            if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
                item_errors[index].append("sha256 must be a lowercase hexadecimal digest")

        for indexes in name_indexes.values():
            if len(indexes) > 1:
                for index in indexes:
                    item_errors[index].append("duplicate snapshot name")
        for indexes in file_indexes.values():
            if len(indexes) > 1:
                for index in indexes:
                    item_errors[index].append("duplicate snapshot file")
        for name, indexes in skipped_name_indexes.items():
            if len(indexes) > 1:
                for index in indexes:
                    skipped_item_errors[index].append("duplicate snapshot name")
            if name in name_indexes:
                for index in indexes:
                    skipped_item_errors[index].append("snapshot name also appears in saved")
                for index in name_indexes[name]:
                    item_errors[index].append("snapshot name also appears in skipped")

        for index, skipped_item in enumerate(skipped_items):
            name = skipped_item.get("name") if isinstance(skipped_item, dict) else "*"
            if skipped_item_errors[index]:
                errors.append({
                    "name": str(name),
                    "reason": f"invalid manifest skipped entry: {'; '.join(skipped_item_errors[index])}",
                })
            else:
                skipped.append(skipped_item)

        entries = []
        validated_total = 0
        for index, item in enumerate(saved_items):
            name = item.get("name") if isinstance(item, dict) else None
            if item_errors[index]:
                errors.append({"name": str(name), "reason": "; ".join(item_errors[index])})
                continue
            if validated_total + item["bytes"] > TOTAL_SNAPSHOT_LIMIT:
                errors.append({"name": item["name"], "reason": "declared total exceeds snapshot limit"})
                continue
            try:
                payload = read_bounded_regular(
                    directory_fd,
                    item["file"],
                    max_bytes=PER_VARIABLE_LIMIT,
                    expected_bytes=item["bytes"],
                    expected_hash=item["sha256"],
                )
                entries.append({"item": item, "payload": payload if load_payloads else None})
                validated_total += item["bytes"]
            except Exception as error:
                errors.append({"name": item["name"], "reason": f"{type(error).__name__}: {error}"})

        return {
            "found": True,
            "manifest": manifest,
            "entries": entries,
            "skipped": skipped,
            "errors": errors,
            "complete": not errors and len(entries) == len(saved_items),
        }
    except Exception as error:
        return {
            "found": True,
            "manifest": None,
            "entries": [],
            "skipped": [],
            "errors": [{"name": "*", "reason": f"invalid snapshot: {type(error).__name__}: {error}"}],
            "complete": False,
        }
    finally:
        os.close(directory_fd)


def recover_previous_snapshot(snapshot_path):
    """Load a valid .previous snapshot for descriptor-bound direct restore.

    A mutable pathname cannot be guaranteed to keep denoting a published inode
    after a final check and across a Python return.  Recovery therefore does not
    stage or publish files into the current directory.  It returns only payloads
    that validation already read from opened regular-file descriptors; startup
    restores those exact bytes in memory and leaves .previous unpromoted.
    """
    target = Path(snapshot_path)
    previous = target.with_name(f"{target.name}.previous")
    try:
        previous_mode = previous.lstat().st_mode
    except FileNotFoundError:
        return {"recovered": False, "reason": "no previous snapshot"}
    except OSError as error:
        return {"recovered": False, "reason": f"previous inspection failed: {type(error).__name__}: {error}"}
    if not stat.S_ISDIR(previous_mode):
        return {"recovered": False, "reason": "previous snapshot is not a directory"}

    directory_flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"):
        directory_flags |= getattr(os, flag_name, 0)
    try:
        target_fd = os.open(target, directory_flags)
    except FileNotFoundError:
        target_fd = None
    except OSError as error:
        return {"recovered": False, "reason": f"target inspection failed: {type(error).__name__}: {error}"}

    if target_fd is not None:
        try:
            target_entries = set(os.listdir(target_fd))
            if "manifest.json" in target_entries:
                return {"recovered": False, "reason": "current snapshot present"}
            if not target_entries.issubset({"kernel-config.json"}):
                return {"recovered": False, "reason": "current directory is not config-only"}
        except OSError as error:
            return {"recovered": False, "reason": f"target inspection failed: {type(error).__name__}: {error}"}
        finally:
            os.close(target_fd)

    # validate_snapshot_directory binds the directory and every manifest/blob
    # read to opened no-follow descriptors.  A later path swap cannot alter the
    # immutable bytes retained in this result.
    previous_validation = validate_snapshot_directory(previous, load_payloads=True)
    if not previous_validation["complete"]:
        return {"recovered": False, "reason": "previous snapshot is invalid"}
    return {
        "recovered": True,
        "reason": "loaded validated previous snapshot directly without publication",
        "_validation": previous_validation,
    }

def reuse_blob(source, destination, expected_bytes, expected_hash):
    try:
        source_mode = source.lstat().st_mode
        if not stat.S_ISREG(source_mode):
            return False
        os.link(source, destination, follow_symlinks=False)
        directory_flags = os.O_RDONLY
        for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"):
            directory_flags |= getattr(os, flag_name, 0)
        directory_fd = os.open(destination.parent, directory_flags)
        try:
            read_bounded_regular(
                directory_fd,
                destination.name,
                max_bytes=PER_VARIABLE_LIMIT,
                expected_bytes=expected_bytes,
                expected_hash=expected_hash,
            )
        finally:
            os.close(directory_fd)
        return True
    except (OSError, ValueError):
        pass
    try:
        destination.unlink()
    except FileNotFoundError:
        pass
    return False


def save_snapshot(snapshot_path, namespace, protected_names, *, namespace_checkpoint=None):
    if namespace_checkpoint is not None and not valid_namespace_checkpoint(namespace_checkpoint):
        raise ValueError("invalid namespace checkpoint")
    durable = namespace_checkpoint is not None
    started_at = time.perf_counter()
    target = Path(snapshot_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f"{target.name}.snapshot-tmp-", dir=target.parent))
    previous = target.with_name(f"{target.name}.previous")
    prior_validation = validate_snapshot_directory(target)
    prior_entries = {entry["item"]["name"]: entry["item"] for entry in prior_validation["entries"]}
    saved = []
    skipped = []
    total = 0
    stats = {
        "attemptedVariables": 0,
        "serializedVariables": 0,
        "boundedVariables": 0,
        "reusedBlobs": 0,
        "reusedBytes": 0,
        "writtenBlobs": 0,
        "writtenBytes": 0,
    }
    try:
        for name in sorted(namespace):
            if name in protected_names or name.startswith("_"):
                continue
            stats["attemptedVariables"] += 1
            value = namespace[name]
            if isinstance(value, (types.ModuleType, SkillProxy)):
                skipped.append({"name": name, "reason": "live runtime object"})
                continue
            remaining_total = TOTAL_SNAPSHOT_LIMIT - total
            serialization_limit = min(PER_VARIABLE_LIMIT, remaining_total)
            sink = BoundedBytesIO(serialization_limit)
            try:
                dill.dump(value, sink)
                payload = sink.getvalue()
            except SnapshotSizeLimitExceeded:
                stats["boundedVariables"] += 1
                reason = "total snapshot size limit" if remaining_total < PER_VARIABLE_LIMIT else "per-variable size limit"
                skipped.append({"name": name, "reason": reason})
                continue
            except Exception as error:
                skipped.append({"name": name, "reason": f"{type(error).__name__}: {error}"})
                continue
            stats["serializedVariables"] += 1
            digest = hashlib.sha256(payload).hexdigest()
            blob_name = f"{len(saved):06d}-{hashlib.sha256(name.encode()).hexdigest()[:12]}.dill"
            blob_path = temporary / blob_name
            prior = prior_entries.get(name)
            reused = False
            if prior is not None and prior["bytes"] == len(payload) and prior["sha256"] == digest:
                reused = reuse_blob(target / prior["file"], blob_path, len(payload), digest)
            if reused:
                stats["reusedBlobs"] += 1
                stats["reusedBytes"] += len(payload)
            else:
                blob_path.write_bytes(payload)
                stats["writtenBlobs"] += 1
                stats["writtenBytes"] += len(payload)
            saved.append({
                "name": name,
                "file": blob_name,
                "bytes": len(payload),
                "sha256": digest,
            })
            total += len(payload)
        if durable:
            # Finish all writes and links before syncing so the filesystem can
            # commit their metadata together. Every payload still reaches fsync
            # before the manifest or snapshot directory can be published.
            for item in saved:
                with (temporary / item["file"]).open("rb") as stream:
                    os.fsync(stream.fileno())
        stats["durationMs"] = round((time.perf_counter() - started_at) * 1000, 3)
        manifest = {
            "version": SNAPSHOT_VERSION,
            "saved": saved,
            "skipped": skipped,
            "totalBytes": total,
            "stats": stats,
        }
        if namespace_checkpoint is not None:
            manifest["namespaceCheckpoint"] = namespace_checkpoint
        atomic_write_json(temporary / "manifest.json", manifest, durable=durable)
        if durable:
            sync_snapshot_directory(temporary)
        moved_current = False
        configuration_hold = None
        if target.exists():
            target_entries = set(path.name for path in target.iterdir())
            if previous.exists() and target_entries.issubset({"kernel-config.json"}):
                configuration_hold = Path(tempfile.mkdtemp(
                    prefix=f"{target.name}.snapshot-config-hold-",
                    dir=target.parent,
                ))
                configuration_hold.rmdir()
                os.replace(target, configuration_hold)
            else:
                if previous.exists():
                    shutil.rmtree(previous)
                os.replace(target, previous)
                moved_current = True
        if durable:
            sync_snapshot_directory(target.parent)
        try:
            os.replace(temporary, target)
            if durable:
                sync_snapshot_directory(target.parent)
        except BaseException:
            if configuration_hold is not None and configuration_hold.exists() and not target.exists():
                os.replace(configuration_hold, target)
            elif moved_current and previous.exists() and not target.exists():
                os.replace(previous, target)
            raise
        if previous.exists():
            shutil.rmtree(previous, ignore_errors=True)
        if configuration_hold is not None:
            shutil.rmtree(configuration_hold, ignore_errors=True)
        return manifest
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        if locals().get("configuration_hold") is not None and configuration_hold.exists() and not target.exists():
            os.replace(configuration_hold, target)
        elif locals().get("moved_current") and previous.exists() and not target.exists():
            os.replace(previous, target)
        raise


def restore_validated_snapshot(validation, namespace, protected_names):
    restored = []
    skipped = [*validation["skipped"], *validation["errors"]]
    for entry in validation["entries"]:
        item = entry["item"]
        name = item["name"]
        if name in protected_names or name.startswith("_"):
            skipped.append({"name": name, "reason": "protected runtime name"})
            continue
        try:
            namespace[name] = dill.loads(entry["payload"])
            restored.append(name)
        except Exception as error:
            skipped.append({"name": name, "reason": f"{type(error).__name__}: {error}"})
    checkpoint = None
    if validation["complete"] and isinstance(validation["manifest"], dict):
        checkpoint = validation["manifest"].get("namespaceCheckpoint")
    return {"restored": restored, "skipped": skipped, "found": True,
            "namespaceCheckpoint": checkpoint}


def restore_snapshot(snapshot_path, namespace, protected_names):
    validation = validate_snapshot_directory(snapshot_path, load_payloads=True)
    if not validation["found"]:
        return {"restored": [], "skipped": [], "found": False}
    return restore_validated_snapshot(validation, namespace, protected_names)


sys.stdout = ProtocolStream(sys.stdout, "stdout")
sys.stderr = ProtocolStream(sys.stderr, "stderr")
shell = InteractiveShell.instance(display_pub_class=ProtocolDisplayPublisher, displayhook_class=ProtocolDisplayHook)
# stdin is /dev/null in this harness, so the default pager hits EOFError on
# long skill?/pinfo output. Display pager content inline instead.
shell.display_page = True
shell.set_hook("show_in_pager", ipython_page.as_hook(ipython_page.display_page), 0)

def _literal_var_expand(cmd, depth=0, formatter=None):
    return cmd


def _disabled_shell_escape(cmd):
    raise RuntimeError("IPython $name expansion and backtick command substitution are disabled for ordinary Python cells")


# Ordinary Python cells, including files.edit payloads, must round-trip `$name`
# and backticks. IPython otherwise expands them via var_expand and /bin/sh.
shell.var_expand = _literal_var_expand
shell.system = _disabled_shell_escape
shell.getoutput = _disabled_shell_escape
manifest = config["manifest"]
proxies = bootstrap_skills(manifest, shell.user_ns)
protected_names = set(shell.user_ns) | set(proxies)
snapshot_recovery_report = recover_previous_snapshot(config["snapshotPath"])
recovery_validation = snapshot_recovery_report.pop("_validation", None)
snapshot_cleanup_report = cleanup_stale_snapshot_temps(config["snapshotPath"])
if recovery_validation is None:
    restore_report = restore_snapshot(config["snapshotPath"], shell.user_ns, protected_names)
else:
    restore_report = restore_validated_snapshot(recovery_validation, shell.user_ns, protected_names)
namespace_checkpoint = restore_report.get("namespaceCheckpoint")
emit({
    "type": "ready",
    "version": PROTOCOL_VERSION,
    "python": sys.version.split()[0],
    "skills": sorted(proxies),
    "restore": restore_report,
    "snapshotCleanup": snapshot_cleanup_report,
    "snapshotRecovery": snapshot_recovery_report,
})

while True:
    try:
        command = receive()
    except EOFError:
        break
    command_type = command.get("type")
    command_id = command.get("id")
    if command_type == "host_response":
        # A host operation may complete just after SIGINT unwinds its nested wait.
        # Its late, correlated response is safe to discard at the top level.
        continue
    active_output_id = command_id if command_type == "execute" else None
    try:
        if command_type == "execute":
            checkpoint = command.get("namespaceCheckpoint")
            if checkpoint is not None and not valid_namespace_checkpoint(checkpoint):
                raise ValueError("invalid namespace checkpoint")
            namespace_checkpoint = checkpoint
            result = shell.run_cell(command.get("code", ""), store_history=True)
            error = result.error_before_exec or result.error_in_exec
            emit({
                "type": "done",
                "id": command_id,
                "ok": error is None,
                "errorType": type(error).__name__ if error is not None else None,
                "error": str(error) if error is not None else None,
            })
        elif command_type == "snapshot":
            snapshot = save_snapshot(config["snapshotPath"], shell.user_ns, protected_names,
                                     namespace_checkpoint=namespace_checkpoint)
            emit({"type": "snapshot_done", "id": command_id, "ok": True, "snapshot": snapshot})
        elif command_type == "shutdown":
            emit({"type": "shutdown_done", "id": command_id})
            break
        else:
            emit({"type": "protocol_error", "id": command_id, "error": f"unsupported command: {command_type}"})
    except KeyboardInterrupt:
        terminal_type = "snapshot_done" if command_type == "snapshot" else "done"
        emit({"type": terminal_type, "id": command_id, "ok": False,
              "errorType": "KeyboardInterrupt", "error": "interrupted"})
    except BaseException as error:
        traceback.print_exc()
        terminal_type = "snapshot_done" if command_type == "snapshot" else "done"
        emit({
            "type": terminal_type,
            "id": command_id,
            "ok": False,
            "errorType": type(error).__name__,
            "error": str(error),
        })

    finally:
        active_output_id = None
