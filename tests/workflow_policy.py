#!/usr/bin/env python3
"""Fail closed on unsafe or drifting GitHub workflow dependencies."""

from __future__ import annotations

import re
from pathlib import Path

from tests.lab import REPO_ROOT

WORKFLOW_DIR = REPO_ROOT / ".github" / "workflows"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
USES = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)")


def top_level_permission_entries(text: str) -> list[str]:
    match = re.search(r"(?m)^permissions:\s*(?:#.*)?$", text)
    if match is None:
        return []

    entries: list[str] = []
    for raw_line in text[match.end() :].splitlines():
        if not raw_line.strip():
            continue
        if not raw_line.startswith((" ", "\t")):
            break
        entry = raw_line.split("#", maxsplit=1)[0].strip()
        if entry:
            entries.append(entry)
    return entries


def validate_workflows(workflow_dir: Path = WORKFLOW_DIR) -> list[str]:
    errors: list[str] = []
    workflow_paths = sorted((*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")))
    if not workflow_paths:
        return ["no GitHub Actions workflows found"]

    for path in workflow_paths:
        text = path.read_text(encoding="utf-8")
        try:
            relative = path.relative_to(REPO_ROOT)
        except ValueError:
            relative = path.relative_to(workflow_dir)
        if "pull_request_target:" in text:
            errors.append(f"{relative}: pull_request_target is forbidden")
        if top_level_permission_entries(text) != ["contents: read"]:
            errors.append(
                f"{relative}: top-level permissions must be contents: read "
                "with no additional scopes"
            )
        for line_number, line in enumerate(text.splitlines(), start=1):
            match = USES.match(line)
            if not match:
                continue
            reference = match.group(1)
            if reference.startswith("./"):
                continue
            if "@" not in reference:
                errors.append(f"{relative}:{line_number}: action reference has no pin")
                continue
            revision = reference.rsplit("@", maxsplit=1)[1]
            if not FULL_SHA.fullmatch(revision):
                errors.append(
                    f"{relative}:{line_number}: external action must use a full commit SHA"
                )
    return errors


def main() -> int:
    errors = validate_workflows()
    if errors:
        raise RuntimeError("\n".join(errors))
    print("GitHub workflow policy passed: least privilege and immutable action pins")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
