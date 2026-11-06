import os

import pytest

from env import _Env

REQUIRED = (
    "MQ_URL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "API_BASE_URL",
    "SUPADATA_API_KEY",
)


def test_reads_all_required_vars():
    e = _Env()
    for var in REQUIRED:
        assert e.get(var) == os.environ[var]


def test_missing_var_fails_startup(monkeypatch):
    monkeypatch.delenv("MQ_URL")
    with pytest.raises(RuntimeError, match="MQ_URL"):
        _Env()


def test_every_missing_var_is_reported(monkeypatch):
    for var in REQUIRED:
        monkeypatch.delenv(var)

    with pytest.raises(RuntimeError) as excinfo:
        _Env()

    for var in REQUIRED:
        assert var in str(excinfo.value)
