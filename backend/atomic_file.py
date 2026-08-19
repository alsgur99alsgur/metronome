import json
import os
import shutil
import tempfile


def _temporary_path(final_path):
    directory = os.path.dirname(os.path.abspath(final_path))
    os.makedirs(directory, exist_ok=True)
    fd, path = tempfile.mkstemp(
        prefix=f".{os.path.basename(final_path)}.",
        suffix=".tmp",
        dir=directory,
    )
    return fd, path


def _replace(temporary, final_path):
    with open(temporary, "r+b") as file:
        _fsync(file)
    os.replace(temporary, final_path)


def _fsync(file):
    try:
        os.fsync(file.fileno())
    except OSError as exc:
        if os.name == "nt" and getattr(exc, "winerror", None) == 6:
            return
        raise


def atomic_write_json(final_path, payload, *, default=None, allow_nan=True, indent=2):
    fd, temporary = _temporary_path(final_path)
    try:
        file = os.fdopen(fd, "w", encoding="utf-8")
        fd = None
        with file:
            json.dump(
                payload,
                file,
                ensure_ascii=False,
                allow_nan=allow_nan,
                indent=indent,
                default=default,
            )
            file.write("\n")
            file.flush()
            _fsync(file)
        os.replace(temporary, final_path)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def atomic_write_parquet(dataframe, final_path, **kwargs):
    fd, temporary = _temporary_path(final_path)
    os.close(fd)
    try:
        dataframe.to_parquet(temporary, **kwargs)
        _replace(temporary, final_path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def atomic_copy(source_path, final_path):
    fd, temporary = _temporary_path(final_path)
    os.close(fd)
    try:
        shutil.copyfile(source_path, temporary)
        _replace(temporary, final_path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def atomic_generate(final_path, writer):
    fd, temporary = _temporary_path(final_path)
    os.close(fd)
    try:
        writer(temporary)
        _replace(temporary, final_path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
