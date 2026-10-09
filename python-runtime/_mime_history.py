"""Share immutable MIME values without owning public IPython history."""

import hashlib
import threading
import weakref

from IPython.core.history import HistoryOutput


class MimeHistory:
    def __init__(self):
        self._lock = threading.RLock()
        self._buckets = {}
        self._next_token = 0

    @staticmethod
    def _signature(value):
        if type(value) is str:
            return (str, hashlib.sha256(value.encode("utf-8", "surrogatepass")).digest())
        if type(value) is bytes:
            return (bytes, hashlib.sha256(value).digest())
        return None

    def _discard(self, signature, token, reference):
        with self._lock:
            bucket = self._buckets.get(signature)
            # HistoryOutput is mutable and unhashable. Never compare weakrefs by
            # value, or use reusable object addresses as registration identities.
            if bucket is not None and bucket.get(token) is reference:
                del bucket[token]
                if not bucket:
                    del self._buckets[signature]

    def _candidate(self, signature, token, reference, value):
        owner = reference()
        current_signature = False
        if owner is not None and type(owner.bundle) is dict:
            for candidate in owner.bundle.values():
                if type(candidate) is type(value) and candidate == value:
                    return candidate
                if self._signature(candidate) == signature:
                    current_signature = True
        # A public bundle can be replaced, edited, or emptied before its record
        # dies. Keep genuine digest collisions indexed; prune stale entries.
        if not current_signature:
            self._discard(signature, token, reference)
        return None

    def _find(self, signature, value):
        bucket = self._buckets.get(signature)
        if bucket:
            # Repeated output normally matches the first live owner. Avoid an
            # O(history length) metadata copy on that path.
            first = next(iter(bucket.items()), None)
            if first is None:
                return value
            token, reference = first
            candidate = self._candidate(signature, token, reference, value)
            if candidate is not None:
                return candidate
            # Weak callbacks and stale-entry pruning can change the bucket.
            for token, reference in bucket.copy().items():
                candidate = self._candidate(signature, token, reference, value)
                if candidate is not None:
                    return candidate
        return value

    def _register(self, signature, owner):
        token = self._next_token
        self._next_token += 1
        pool_reference = weakref.ref(self)

        def released(reference):
            pool = pool_reference()
            if pool is not None:
                pool._discard(signature, token, reference)

        # The callback captures only a pool weakref, a typed digest, and a
        # monotonic token: no record, bundle, MIME key, or payload.
        self._buckets.setdefault(signature, {})[token] = weakref.ref(owner, released)

    def record(self, output_type, bundle):
        with self._lock:
            owner = HistoryOutput(output_type=output_type, bundle=bundle)
            if type(bundle) is dict:
                registered = set()
                for key, value in bundle.items():
                    signature = self._signature(value)
                    if signature is None:
                        continue
                    bundle[key] = self._find(signature, value)
                    if signature not in registered:
                        self._register(signature, owner)
                        registered.add(signature)
            return owner
