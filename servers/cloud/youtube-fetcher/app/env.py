import os
import sys
from typing import Literal

ANSI_RED = "\033[31m"
ANSI_RESET = "\033[0m"

EnvKey = Literal[
    "MQ_URL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "API_BASE_URL",
    "SUPADATA_API_KEY",
]


class _Env:
    REQUIRED_VARS: tuple[EnvKey, ...] = (
        "MQ_URL",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "API_BASE_URL",
        "SUPADATA_API_KEY",
    )

    def __init__(self):
        for var in self.REQUIRED_VARS:
            setattr(self, var, os.getenv(var))

        self.warn_if_not_running_under_doppler()
        self.verify()

    def warn_if_not_running_under_doppler(self):
        """Doppler injects these into every process it wraps, so their absence
        means the values came from the ambient shell instead. A stale
        API_BASE_URL points the fetcher at the wrong host in ways that are
        painful to trace, so say so loudly.

        Not in a container: there the environment comes from the platform and
        Doppler is never in the picture, so this would fire on every boot and
        read as a failure when nothing is wrong."""
        if os.getenv("APP_ENV") == "production":
            return
        if os.getenv("DOPPLER_PROJECT") and os.getenv("DOPPLER_CONFIG"):
            return

        print(
            f"{ANSI_RED}[env] Doppler is not injecting this process — falling "
            f"back to the ambient environment. URLs may point at the wrong "
            f"host. Start it with `doppler run -- <command>`.{ANSI_RESET}",
            file=sys.stderr,
        )

    def verify(self):
        missing = [var for var in self.REQUIRED_VARS if getattr(self, var) is None]

        if missing:
            raise RuntimeError(f"Missing environment variables: {', '.join(missing)}")

    def get(self, key: EnvKey) -> str:
        return getattr(self, key)


env = _Env()
