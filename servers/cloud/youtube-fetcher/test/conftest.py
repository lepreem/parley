"""Shared test setup.

The app modules do real work at import time — env.py validates the
environment and bucket.py builds the Supabase client — so the dummy values
must be in place before the first app import. pytest imports conftest.py
ahead of any test module, which is what makes this ordering hold.
"""

import os
import sys
from pathlib import Path

os.environ["MQ_URL"] = "amqp://guest:guest@localhost:5672"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "dummy-key"
os.environ["SUPADATA_API_KEY"] = "dummy-supadata-key"
# Trailing slash on purpose: contract.load() must normalise it away.
os.environ["API_BASE_URL"] = "http://api.test/"

# The app modules import each other as top-level modules (`from env import
# env`), matching how app.py runs as a script — so tests need app/ on the path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
