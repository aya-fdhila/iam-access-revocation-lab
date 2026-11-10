#!/usr/bin/env python3
"""Refuse publication of incomplete canonical experiment evidence."""

from __future__ import annotations

import argparse
from pathlib import Path

from evidence import validate_all
from lab import REPO_ROOT


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=REPO_ROOT / "results")
    args = parser.parse_args()
    validate_all(args.results)
    print("canonical evidence is complete and internally consistent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
