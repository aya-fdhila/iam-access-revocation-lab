from __future__ import annotations

import json
import sys

import pytest

import tests.report_metrics as report_metrics
from tests.report_metrics import (
    DEMO_SCRIPT,
    OUTPUT,
    REPORT,
    derive,
    serialized_summary,
    validate_report_markers,
)


def test_committed_report_summary_matches_canonical_csv() -> None:
    assert OUTPUT.read_text(encoding="utf-8") == serialized_summary()


def test_report_summary_keeps_source_and_calculation_for_every_metric() -> None:
    summary = derive()
    assert summary["generated_from"] == [
        "results/matrix.csv",
        "results/offboarding.csv",
        "results/bench.csv",
    ]
    assert summary["metrics"]
    for metric in summary["metrics"].values():
        assert metric["source"] in summary["generated_from"]
        assert metric["selection"]
        assert metric["calculation"]
        assert metric["unit"]
        assert isinstance(metric["value"], int | float)


def test_summary_is_stable_json() -> None:
    parsed = json.loads(serialized_summary())
    assert parsed == derive()


def test_report_values_match_every_derived_metric_and_figure() -> None:
    validate_report_markers(derive())
    report = REPORT.read_text(encoding="utf-8")
    for figure in ("matrix.png", "offboarding.png", "benchmark.png"):
        assert f"../results/{figure}" in report


def test_report_value_drift_is_rejected(tmp_path) -> None:
    summary = derive()
    report = REPORT.read_text(encoding="utf-8")
    current_value = summary["metrics"]["bench_local_throughput_rps"]["value"]
    current_marker = f"{current_value}<!-- metric:bench_local_throughput_rps -->"
    assert current_marker in report
    stale_report = tmp_path / "report.md"
    stale_report.write_text(
        report.replace(
            current_marker,
            "999.000<!-- metric:bench_local_throughput_rps -->",
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="bench_local_throughput_rps"):
        validate_report_markers(summary, (stale_report,))


def test_demo_value_drift_is_rejected(tmp_path) -> None:
    summary = derive()
    demo = DEMO_SCRIPT.read_text(encoding="utf-8")
    current_value = summary["metrics"]["bench_cached_keycloak_calls_per_request"]["value"]
    current_marker = f"{current_value}<!-- metric:bench_cached_keycloak_calls_per_request -->"
    assert current_marker in demo
    stale_demo = tmp_path / "demo-script.md"
    stale_demo.write_text(
        demo.replace(
            current_marker,
            "0.999<!-- metric:bench_cached_keycloak_calls_per_request -->",
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="bench_cached_keycloak_calls_per_request"):
        validate_report_markers(summary, (REPORT, stale_demo))


def test_unknown_metric_marker_is_rejected(tmp_path) -> None:
    unknown_surface = tmp_path / "unknown.md"
    unknown_surface.write_text(
        "1<!-- metric:does_not_exist -->\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="unknown metric marker: does_not_exist"):
        validate_report_markers(derive(), (unknown_surface,))


def test_missing_metric_marker_is_rejected(tmp_path) -> None:
    empty_surface = tmp_path / "empty.md"
    empty_surface.write_text("No evidence markers.\n", encoding="utf-8")

    with pytest.raises(ValueError, match="missing value markers for"):
        validate_report_markers(derive(), (empty_surface,))


def test_regeneration_writes_ledger_before_report_reconciliation(tmp_path, monkeypatch) -> None:
    output = tmp_path / "evidence-summary.json"

    def refuse_validation(*_args, **_kwargs) -> None:
        raise AssertionError("regeneration must not validate stale report markers")

    monkeypatch.setattr(report_metrics, "validate_report_markers", refuse_validation)
    monkeypatch.setattr(sys, "argv", ["report_metrics", "--output", str(output)])
    assert report_metrics.main() == 0
    assert output.read_text(encoding="utf-8") == serialized_summary()
