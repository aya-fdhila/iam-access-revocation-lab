from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from services.offboarding.cli import (
    OffboardingWorkflow,
    ReceiptWriter,
    WorkflowError,
)


def workflow(tmp_path: Path, *, mode: str, refresh_token: str | None = None) -> OffboardingWorkflow:
    return OffboardingWorkflow(
        user="marwa",
        mode=mode,
        phase="t1",
        environment={
            "LDAP_ADMIN_PASSWORD": "ldap-secret",
            "KC_ADMIN_PASSWORD": "keycloak-secret",
            "OFFBOARDING_API_SECRET": "api-secret",
        },
        receipt_writer=ReceiptWriter(tmp_path / "receipt.jsonl"),
        correlation_id="test-correlation",
        refresh_token=refresh_token,
        http_client=object(),  # type: ignore[arg-type]
    )


def stub_mutations(monkeypatch: pytest.MonkeyPatch, target: OffboardingWorkflow) -> list[str]:
    called: list[str] = []

    def operation(name: str) -> Any:
        def run(*_args: Any, **_kwargs: Any) -> tuple[str, str]:
            called.append(name)
            return "changed", name

        return run

    for attribute in (
        "_ldap_lock",
        "_keycloak_set_enabled",
        "_keycloak_logout",
        "_revoke_refresh_token",
        "_set_not_before",
    ):
        monkeypatch.setattr(target, attribute, operation(attribute))
    return called


def test_baseline_stops_after_ldap_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = workflow(tmp_path, mode="baseline")
    called = stub_mutations(monkeypatch, target)
    target.run()
    assert called == ["_ldap_lock"]


def test_automated_t1_runs_every_invalidation_step_without_leaking_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = "sensitive-refresh-token"
    target = workflow(tmp_path, mode="automated", refresh_token=token)
    called = stub_mutations(monkeypatch, target)
    target.run()
    assert called == [
        "_ldap_lock",
        "_keycloak_set_enabled",
        "_keycloak_logout",
        "_revoke_refresh_token",
        "_set_not_before",
    ]
    receipt_text = (tmp_path / "receipt.jsonl").read_text(encoding="utf-8")
    assert token not in receipt_text
    assert all(json.loads(line)["outcome"] == "changed" for line in receipt_text.splitlines())


def test_invalid_username_is_refused(tmp_path: Path) -> None:
    with pytest.raises(WorkflowError):
        OffboardingWorkflow(
            user="../../admin",
            mode="automated",
            phase="full",
            environment={},
            receipt_writer=ReceiptWriter(tmp_path / "receipt.jsonl"),
            correlation_id="test",
            refresh_token=None,
            http_client=object(),  # type: ignore[arg-type]
        )


def test_non_subject_lab_user_is_refused(tmp_path: Path) -> None:
    with pytest.raises(WorkflowError):
        OffboardingWorkflow(
            user="aya",
            mode="automated",
            phase="full",
            environment={},
            receipt_writer=ReceiptWriter(tmp_path / "receipt.jsonl"),
            correlation_id="test",
            refresh_token=None,
            http_client=object(),  # type: ignore[arg-type]
        )


def test_path_like_correlation_id_is_refused(tmp_path: Path) -> None:
    with pytest.raises(WorkflowError):
        OffboardingWorkflow(
            user="marwa",
            mode="automated",
            phase="full",
            environment={},
            receipt_writer=ReceiptWriter(tmp_path / "receipt.jsonl"),
            correlation_id="../../outside",
            refresh_token=None,
            http_client=object(),  # type: ignore[arg-type]
        )
