from __future__ import annotations

import csv
from pathlib import Path

import pytest

from tests.evidence import (
    EXPECTED_NEGATIVE_PROFILES,
    EXPECTED_POLICY_PROFILES,
    EXPECTED_ROUTE_OPERATIONS,
    validate_benchmark,
    validate_matrix,
)


def write_rows(path: Path, rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys(), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def test_matrix_requires_equal_passing_rows_per_mode(tmp_path: Path) -> None:
    path = tmp_path / "matrix.csv"
    write_rows(
        path,
        [
            {
                "case_type": "policy",
                "mode": mode,
                "outcome": "pass",
                "profile": profile,
                "method": method,
                "route": route,
            }
            for mode in ("local", "introspection", "cached")
            for profile in EXPECTED_POLICY_PROFILES
            for method, route in EXPECTED_ROUTE_OPERATIONS
        ]
        + [
            {
                "case_type": "token_validation",
                "mode": mode,
                "outcome": "pass",
                "profile": profile,
                "method": "GET",
                "route": "/me",
            }
            for mode in ("local", "introspection", "cached")
            for profile in EXPECTED_NEGATIVE_PROFILES
        ],
    )
    validate_matrix(path)
    write_rows(
        path,
        [
            {
                "case_type": "policy",
                "mode": "local",
                "outcome": "fail",
                "profile": "anonymous",
                "method": "GET",
                "route": "/health",
            }
        ],
    )
    with pytest.raises(ValueError):
        validate_matrix(path)


def test_benchmark_refuses_failed_requests(tmp_path: Path) -> None:
    path = tmp_path / "bench.csv"
    rows = [
        {
            "mode": mode,
            "request_count": 10,
            "concurrency": 10,
            "successful_requests": 10,
            "throughput_rps": 1,
            "latency_p50_ms": 1,
            "latency_p95_ms": 2,
            "keycloak_calls_per_request": 0,
            "environment": "{}",
        }
        for mode in ("local", "introspection", "cached")
    ]
    for row in rows:
        row["request_count"] = 1000
        row["successful_requests"] = 1000
    write_rows(path, rows)
    validate_benchmark(path)
    rows[0]["successful_requests"] = 9
    write_rows(path, rows)
    with pytest.raises(ValueError):
        validate_benchmark(path)
