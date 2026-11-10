#!/usr/bin/env python3
"""Derive the report's numeric evidence ledger from canonical CSV results."""

from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
from collections import Counter
from decimal import Decimal
from pathlib import Path
from typing import Any

from tests.evidence import validate_all
from tests.lab import REPO_ROOT

RESULTS = REPO_ROOT / "results"
OUTPUT = REPO_ROOT / "report" / "evidence-summary.json"
REPORT = REPO_ROOT / "report" / "report.md"
DEMO_SCRIPT = REPO_ROOT / "docs" / "demo-script.md"
EVIDENCE_SURFACES = (REPORT, DEMO_SCRIPT)
METRIC_MARKER = re.compile(
    r"(?P<value>-?\d+(?:,\d{3})*(?:\.\d+)?)<!-- metric:(?P<metric>[a-z0-9_]+) -->"
)


def read_csv(name: str) -> list[dict[str, str]]:
    with (RESULTS / name).open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def display_path(path: Path) -> Path:
    try:
        return path.relative_to(REPO_ROOT)
    except ValueError:
        return path


def rounded_mean(values: list[float]) -> float:
    if not values:
        raise ValueError("cannot derive a report mean from an empty evidence set")
    return round(statistics.mean(values), 3)


def evidence(
    value: int | float,
    unit: str,
    source: str,
    selection: str,
    calculation: str,
) -> dict[str, Any]:
    return {
        "value": value,
        "unit": unit,
        "source": source,
        "selection": selection,
        "calculation": calculation,
    }


def derive() -> dict[str, Any]:
    validate_all(RESULTS)
    matrix = read_csv("matrix.csv")
    offboarding = read_csv("offboarding.csv")
    bench = read_csv("bench.csv")

    statuses = Counter(int(row["obtained_status"]) for row in matrix)
    outcomes = Counter(row["outcome"] for row in offboarding)

    def delays(
        *,
        offboarding_mode: str,
        validation_mode: str,
        element: str,
        origin: str,
        lifetime: int | None = None,
        outcome: str = "observed",
    ) -> list[float]:
        key = f"delay_from_{origin.lower()}_s"
        return [
            float(row[key])
            for row in offboarding
            if row["offboarding_mode"] == offboarding_mode
            and row["validation_mode"] == validation_mode
            and row["element"] == element
            and row["outcome"] == outcome
            and (lifetime is None or int(row["lifetime_s"]) == lifetime)
        ]

    metrics: dict[str, dict[str, Any]] = {
        "matrix_rows": evidence(len(matrix), "rows", "results/matrix.csv", "all rows", "count"),
        "matrix_passes": evidence(
            sum(row["outcome"] == "pass" for row in matrix),
            "rows",
            "results/matrix.csv",
            "outcome=pass",
            "count",
        ),
        "matrix_status_200": evidence(
            statuses[200], "rows", "results/matrix.csv", "obtained_status=200", "count"
        ),
        "matrix_status_201": evidence(
            statuses[201], "rows", "results/matrix.csv", "obtained_status=201", "count"
        ),
        "matrix_status_204": evidence(
            statuses[204], "rows", "results/matrix.csv", "obtained_status=204", "count"
        ),
        "matrix_status_401": evidence(
            statuses[401], "rows", "results/matrix.csv", "obtained_status=401", "count"
        ),
        "matrix_status_403": evidence(
            statuses[403], "rows", "results/matrix.csv", "obtained_status=403", "count"
        ),
        "offboarding_rows": evidence(
            len(offboarding), "rows", "results/offboarding.csv", "all rows", "count"
        ),
        "offboarding_runs": evidence(
            len({row["run_id"] for row in offboarding}),
            "runs",
            "results/offboarding.csv",
            "distinct run_id",
            "count distinct",
        ),
        "offboarding_observed": evidence(
            outcomes["observed"],
            "rows",
            "results/offboarding.csv",
            "outcome=observed",
            "count",
        ),
        "offboarding_censored": evidence(
            outcomes["censored"],
            "rows",
            "results/offboarding.csv",
            "outcome=censored",
            "count",
        ),
    }

    for lifetime in (60, 300, 900):
        values = delays(
            offboarding_mode="baseline",
            validation_mode="local",
            element="api_authenticated",
            origin="T1",
            lifetime=lifetime,
        )
        metrics[f"baseline_local_auth_t1_mean_{lifetime}s"] = evidence(
            rounded_mean(values),
            "seconds",
            "results/offboarding.csv",
            f"offboarding_mode=baseline; validation_mode=local; "
            f"element=api_authenticated; lifetime_s={lifetime}; outcome=observed",
            "arithmetic mean of delay_from_t1_s",
        )

    derived_delay_specs = {
        "baseline_new_login_t1_mean": ("baseline", "identity", "new_login", "T1"),
        "baseline_introspection_document_t0_mean": (
            "baseline",
            "introspection",
            "api_document_access",
            "T0",
        ),
        "baseline_cached_document_t0_mean": (
            "baseline",
            "cached",
            "api_document_access",
            "T0",
        ),
        "automated_new_login_t1_mean": ("automated", "identity", "new_login", "T1"),
        "automated_refresh_t1_mean": ("automated", "identity", "refresh_chain", "T1"),
        "automated_local_auth_t1_mean": ("automated", "local", "api_authenticated", "T1"),
        "automated_introspection_auth_t1_mean": (
            "automated",
            "introspection",
            "api_authenticated",
            "T1",
        ),
        "automated_cached_auth_t1_mean": (
            "automated",
            "cached",
            "api_authenticated",
            "T1",
        ),
        "automated_cached_auth_t0_mean": (
            "automated",
            "cached",
            "api_authenticated",
            "T0",
        ),
    }
    for metric_id, (
        offboarding_mode,
        validation_mode,
        element,
        origin,
    ) in derived_delay_specs.items():
        values = delays(
            offboarding_mode=offboarding_mode,
            validation_mode=validation_mode,
            element=element,
            origin=origin,
        )
        metrics[metric_id] = evidence(
            rounded_mean(values),
            "seconds",
            "results/offboarding.csv",
            f"offboarding_mode={offboarding_mode}; validation_mode={validation_mode}; "
            f"element={element}; outcome=observed",
            f"arithmetic mean of delay_from_{origin.lower()}_s",
        )

    automated_local = delays(
        offboarding_mode="automated",
        validation_mode="local",
        element="api_authenticated",
        origin="T1",
    )
    metrics["automated_local_auth_t1_max"] = evidence(
        round(max(automated_local), 3),
        "seconds",
        "results/offboarding.csv",
        "offboarding_mode=automated; validation_mode=local; "
        "element=api_authenticated; outcome=observed",
        "maximum delay_from_t1_s",
    )

    baseline_refresh = [
        row
        for row in offboarding
        if row["offboarding_mode"] == "baseline"
        and row["validation_mode"] == "identity"
        and row["element"] == "refresh_chain"
        and row["outcome"] == "censored"
    ]
    metrics["baseline_refresh_censored"] = evidence(
        len(baseline_refresh),
        "chains",
        "results/offboarding.csv",
        "offboarding_mode=baseline; validation_mode=identity; "
        "element=refresh_chain; outcome=censored",
        "count",
    )

    for row in bench:
        mode = row["mode"]
        for field, unit in (
            ("throughput_rps", "requests/second"),
            ("latency_p50_ms", "milliseconds"),
            ("latency_p95_ms", "milliseconds"),
            ("keycloak_calls_per_request", "calls/request"),
        ):
            metrics[f"bench_{mode}_{field}"] = evidence(
                round(float(row[field]), 6),
                unit,
                "results/bench.csv",
                f"mode={mode}",
                field,
            )

    return {
        "schema_version": 1,
        "generated_from": [
            "results/matrix.csv",
            "results/offboarding.csv",
            "results/bench.csv",
        ],
        "metrics": metrics,
    }


def serialized_summary() -> str:
    return json.dumps(derive(), indent=2, sort_keys=True) + "\n"


def validate_report_markers(
    summary: dict[str, Any], evidence_surfaces: tuple[Path, ...] = EVIDENCE_SURFACES
) -> None:
    seen: set[str] = set()
    metrics = summary["metrics"]
    for surface in evidence_surfaces:
        content = surface.read_text(encoding="utf-8")
        surface_label = display_path(surface)
        for match in METRIC_MARKER.finditer(content):
            metric_id = match.group("metric")
            if metric_id not in metrics:
                raise ValueError(f"evidence surface references unknown metric marker: {metric_id}")
            reported = Decimal(match.group("value").replace(",", ""))
            expected = Decimal(str(metrics[metric_id]["value"]))
            if reported != expected:
                raise ValueError(
                    f"evidence value for {metric_id} is {reported}, "
                    f"expected {expected} from canonical CSV in {surface_label}"
                )
            seen.add(metric_id)

    missing = sorted(set(metrics) - seen)
    if missing:
        raise ValueError(f"evidence surfaces are missing value markers for: {', '.join(missing)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="refuse a stale committed ledger")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()

    summary = derive()
    expected = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    if args.check:
        validate_report_markers(summary)
        if not args.output.exists() or args.output.read_text(encoding="utf-8") != expected:
            raise SystemExit(
                f"{display_path(args.output)} is stale; run python -m tests.report_metrics"
            )
        print("report evidence summary matches canonical CSV evidence")
        return 0

    args.output.write_text(expected, encoding="utf-8")
    print(f"wrote {display_path(args.output)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
