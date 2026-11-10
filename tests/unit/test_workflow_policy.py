from __future__ import annotations

from pathlib import Path

from tests.workflow_policy import validate_workflows


def test_repository_workflows_follow_policy() -> None:
    assert validate_workflows() == []


def test_policy_refuses_mutable_actions_and_privileged_pr_trigger(tmp_path: Path) -> None:
    workflow = tmp_path / "unsafe.yml"
    workflow.write_text(
        """name: unsafe
pull_request_target:
permissions:
  contents: write
jobs:
  unsafe:
    steps:
      - uses: actions/checkout@v7
""",
        encoding="utf-8",
    )
    errors = validate_workflows(tmp_path)
    assert any("pull_request_target is forbidden" in error for error in errors)
    assert any("permissions must be contents: read" in error for error in errors)
    assert any("full commit SHA" in error for error in errors)


def test_policy_refuses_additional_write_permission(tmp_path: Path) -> None:
    workflow = tmp_path / "extra-scope.yml"
    workflow.write_text(
        """name: extra-scope
permissions:
  contents: read
  id-token: write
jobs: {}
""",
        encoding="utf-8",
    )
    errors = validate_workflows(tmp_path)
    assert any("no additional scopes" in error for error in errors)
