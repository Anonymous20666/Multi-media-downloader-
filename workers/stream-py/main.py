"""Stream worker stub (Foundation). Real engine lands in V1.5 (ADR-02)."""

import json
import sys
import time

print(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "lv": "info",
                  "msg": "stream worker stub alive — engine arrives in V1.5"}))
sys.stdout.flush()
# Stub exits 0: in Foundation there is nothing to drive it yet.
