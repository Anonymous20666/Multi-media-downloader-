"""Backward-compat launcher — prefer `python -m worker.main` from this directory."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from worker.main import main

if __name__ == "__main__":
    raise SystemExit(main())
