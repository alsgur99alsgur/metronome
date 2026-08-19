import os
import sys


def _has_valid_windows_handle(stream):
    if stream is None:
        return False
    try:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        descriptor = stream.fileno()
        if descriptor < 0:
            return False
        handle = msvcrt.get_osfhandle(descriptor)
        if handle in (-1, 0):
            return False
        kernel32 = ctypes.windll.kernel32
        kernel32.GetFileType.argtypes = [wintypes.HANDLE]
        kernel32.GetFileType.restype = wintypes.DWORD
        kernel32.SetLastError(0)
        file_type = kernel32.GetFileType(handle)
        return file_type != 0 or kernel32.GetLastError() == 0
    except (AttributeError, OSError, ValueError):
        return False


def ensure_windows_standard_streams():
    """Give fd-capturing libraries valid streams in a packaged Windows child."""
    if sys.platform != "win32":
        return

    stream_specs = (
        ("stdin", "CONIN$", "r", 0),
        ("stdout", "CONOUT$", "w", 1),
        ("stderr", "CONOUT$", "w", 2),
    )
    for attribute, console_path, mode, standard_fd in stream_specs:
        current = getattr(sys, attribute)
        if not _has_valid_windows_handle(current):
            try:
                current = open(
                    console_path,
                    mode,
                    encoding="utf-8",
                    buffering=1,
                )
            except OSError:
                current = open(
                    os.devnull,
                    mode,
                    encoding="utf-8",
                    buffering=1,
                )
            setattr(sys, attribute, current)

        # Pyomo capture_output duplicates descriptors 0/1/2 directly. A
        # packaged windowless process can have usable sys streams while those
        # fixed descriptors still reference invalid Windows handles.
        if current.fileno() != standard_fd:
            os.dup2(current.fileno(), standard_fd, inheritable=True)
