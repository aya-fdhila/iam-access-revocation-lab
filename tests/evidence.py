"""Canonical evidence completeness validation."""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path

EXPECTED_LIFETIMES = {60, 300, 900}
EXPECTED_MODES = {"local", "introspection", "cached"}
EXPECTED_STRATEGIES = {"baseline", "automated"}
EXPECTED_POLICY_PROFILES = {
    "anonymous",
    "ali_employee",
    "marwa_employee_owner",
    "marwen_manager",
    "aya_admin",
    "yassmine_admin",
    "job_service",
}
EXPECTED_ROUTE_OPERATIONS = {
    ("GET", "/health"),
    ("GET", "/me"),
    ("GET", "/documents"),
    ("GET", "/documents/3"),
    ("POST", "/documents"),
    ("DELETE", "/documents/:id"),
    ("GET", "/admin/users"),
    ("POST", "/reports/run"),
}
EXPECTED_NEGATIVE_PROFILES = {
    "tampered_signature",
    "wrong_audience",
    "expired_token",
}
EXPECTED_ELEMENTS = {
    ("identity", "new_login"),
    ("identity", "refresh_chain"),
    *(
        (mode, element)
        for mode in EXPECTED_MODES
        for element in ("api_authenticated", "api_document_access")
    ),
}


def rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def validate_matrix(path: Path) -> None:
    evidence = rows(path)
    if not evidence or any(row["outcome"] != "pass" for row in evidence):
        raise ValueError("matrix evidence is empty or contains mismatches")
    counts = Counter(row["mode"] for row in evidence)
    if set(counts) != EXPECTED_MODES or len(set(counts.values())) != 1:
        raise ValueError("matrix modes are incomplete or uneven")
    policy = [row for row in evidence if row["case_type"] == "policy"]
    policy_combinations = Counter(
        (row["mode"], row["profile"], row["method"], row["route"]) for row in policy
    )
    expected_policy = {
        (mode, profile, method, route)
        for mode in EXPECTED_MODES
        for profile in EXPECTED_POLICY_PROFILES
        for method, route in EXPECTED_ROUTE_OPERATIONS
    }
    if set(policy_combinations) != expected_policy or any(
        count != 1 for count in policy_combinations.values()
    ):
        raise ValueError(
            "policy matrix profile/route/mode combinations are incomplete or duplicated"
        )

    negative = [row for row in evidence if row["case_type"] == "token_validation"]
    negative_combinations = Counter(
        (row["mode"], row["profile"], row["method"], row["route"]) for row in negative
    )
    expected_negative = {
        (mode, profile, "GET", "/me")
        for mode in EXPECTED_MODES
        for profile in EXPECTED_NEGATIVE_PROFILES
    }
    if set(negative_combinations) != expected_negative or any(
        count != 1 for count in negative_combinations.values()
    ):
        raise ValueError("token-validation matrix cases are incomplete or duplicated")

    if len(policy) + len(negative) != len(evidence):
        raise ValueError("matrix contains an unknown case type")


def validate_offboarding(path: Path) -> None:
    evidence = rows(path)
    expected_rows = len(EXPECTED_LIFETIMES) * 3 * len(EXPECTED_STRATEGIES) * 8
    if len(evidence) != expected_rows:
        raise ValueError(f"offboarding evidence must contain {expected_rows} rows")
    if {int(row["lifetime_s"]) for row in evidence} != EXPECTED_LIFETIMES:
        raise ValueError("offboarding lifetimes are incomplete")
    if {row["offboarding_mode"] for row in evidence} != EXPECTED_STRATEGIES:
        raise ValueError("offboarding strategies are incomplete")
    combinations = Counter(
        (
            int(row["lifetime_s"]),
            int(row["repetition"]),
            row["offboarding_mode"],
            row["validation_mode"],
            row["element"],
        )
        for row in evidence
    )
    expected = {
        (lifetime, repetition, strategy, validation_mode, element)
        for lifetime in EXPECTED_LIFETIMES
        for repetition in (1, 2, 3)
        for strategy in EXPECTED_STRATEGIES
        for validation_mode, element in EXPECTED_ELEMENTS
    }
    if set(combinations) != expected or any(count != 1 for count in combinations.values()):
        raise ValueError("offboarding run/element combinations are incomplete or duplicated")
    if any(row["outcome"] not in {"observed", "censored", "failed"} for row in evidence):
        raise ValueError("offboarding outcomes must preserve observations, censoring, or failures")
    for row in evidence:
        if row["outcome"] == "observed" and (
            not row["observed_at"] or not row["delay_from_t0_s"] or not row["delay_from_t1_s"]
        ):
            raise ValueError("an observed row is missing timing data")


def validate_benchmark(path: Path) -> None:
    evidence = rows(path)
    if {row["mode"] for row in evidence} != EXPECTED_MODES or len(evidence) != 3:
        raise ValueError("benchmark must contain exactly one row per validation mode")
    if {row["request_count"] for row in evidence} != {"1000"} or {
        row["concurrency"] for row in evidence
    } != {"10"}:
        raise ValueError("canonical benchmark load must be 1,000 requests at concurrency 10")
    for row in evidence:
        if int(row["request_count"]) < 1 or int(row["successful_requests"]) != int(
            row["request_count"]
        ):
            raise ValueError("benchmark contains failed or missing requests")
        for field in (
            "throughput_rps",
            "latency_p50_ms",
            "latency_p95_ms",
            "keycloak_calls_per_request",
        ):
            if float(row[field]) < 0:
                raise ValueError(f"benchmark field {field} cannot be negative")
        if not row["environment"]:
            raise ValueError("benchmark environment metadata is missing")


def validate_all(directory: Path) -> None:
    validate_matrix(directory / "matrix.csv")
    validate_offboarding(directory / "offboarding.csv")
    validate_benchmark(directory / "bench.csv")
