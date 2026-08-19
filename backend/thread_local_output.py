import io
import sys
from contextlib import contextmanager
from threading import RLock, local


class CappedTextBuffer:
    """UTF-8 text buffer with a hard byte limit and one truncation marker."""

    def __init__(self, limit_bytes):
        self.limit_bytes = int(limit_bytes)
        if self.limit_bytes < 1024:
            raise ValueError("executor.nodeLogLimitKb must be at least 1.")
        self._buffer = io.StringIO()
        self._byte_count = 0
        self._truncated = False
        self._lock = RLock()

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, value):
        text = value if isinstance(value, str) else str(value)
        if not text:
            return 0
        encoded = text.encode("utf-8", errors="replace")
        with self._lock:
            if self._truncated:
                return len(text)
            if self._byte_count + len(encoded) <= self.limit_bytes:
                self._buffer.write(text)
                self._byte_count += len(encoded)
                return len(text)

            marker = f"\n[Log truncated at {self.limit_bytes} bytes.]\n".encode("utf-8")
            payload_limit = max(0, self.limit_bytes - len(marker))
            combined = self._buffer.getvalue().encode("utf-8", errors="replace") + encoded
            prefix = combined[:payload_limit].decode("utf-8", errors="ignore")
            final_text = prefix + marker.decode("utf-8")
            self._buffer.seek(0)
            self._buffer.truncate(0)
            self._buffer.write(final_text)
            self._byte_count = len(final_text.encode("utf-8"))
            self._truncated = True
        return len(text)

    def flush(self):
        return None

    def getvalue(self):
        with self._lock:
            return self._buffer.getvalue()


class ThreadLocalOutputRouter:
    """Route writes to the current thread's buffer or the original stream."""

    def __init__(self, fallback):
        self.fallback = fallback
        self._local = local()

    @property
    def encoding(self):
        return getattr(self.fallback, "encoding", "utf-8")

    @property
    def errors(self):
        return getattr(self.fallback, "errors", "replace")

    def _stack(self):
        stack = getattr(self._local, "stack", None)
        if stack is None:
            stack = []
            self._local.stack = stack
        return stack

    def push(self, target):
        self._stack().append(target)

    def pop(self):
        stack = self._stack()
        if not stack:
            raise RuntimeError("Thread-local output buffer stack is empty.")
        target = stack.pop()
        if not stack:
            del self._local.stack
        return target

    def _target(self):
        stack = getattr(self._local, "stack", None)
        return stack[-1] if stack else self.fallback

    def write(self, value):
        target = self._target()
        return target.write(value) if target is not None else len(value)

    def flush(self):
        target = self._target()
        if target is not None and hasattr(target, "flush"):
            target.flush()

    def isatty(self):
        target = self._target()
        return bool(target is not None and getattr(target, "isatty", lambda: False)())

    def fileno(self):
        # In-memory node log targets intentionally have no descriptor. Native
        # libraries (notably Pyomo's capture_output on Windows) still require
        # the process stream descriptor while writes remain thread-local.
        if self.fallback is None or not hasattr(self.fallback, "fileno"):
            raise io.UnsupportedOperation("fileno")
        return self.fallback.fileno()

    def __getattr__(self, name):
        if self.fallback is None:
            raise AttributeError(name)
        return getattr(self.fallback, name)


def install_thread_local_output():
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    stdout_router = (
        original_stdout
        if isinstance(original_stdout, ThreadLocalOutputRouter)
        else ThreadLocalOutputRouter(original_stdout)
    )
    stderr_router = (
        original_stderr
        if isinstance(original_stderr, ThreadLocalOutputRouter)
        else ThreadLocalOutputRouter(original_stderr)
    )
    sys.stdout = stdout_router
    sys.stderr = stderr_router
    return stdout_router, stderr_router, original_stdout, original_stderr


def restore_thread_local_output(original_stdout, original_stderr):
    sys.stdout = original_stdout
    sys.stderr = original_stderr


@contextmanager
def capture_thread_output(stdout_router, stderr_router, target):
    stdout_router.push(target)
    try:
        stderr_router.push(target)
        try:
            yield target
        finally:
            stderr_router.pop()
    finally:
        stdout_router.pop()
