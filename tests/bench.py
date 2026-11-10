#!/usr/bin/env python3
"""Benchmark the three validation modes with fixed load and metric-derived IdP calls."""

from __future__ import annotations

import argparse
import csv
import os
import subprocess
from pathlib import Path

from lab import (
    MODES,
    REPO_ROOT,
    LabClient,
    benchmark_requests,
    environment_metadata,
    parse_metric,
    percentile,
    stable_json,
    staging_path,
)

FIELDNAMES = (
    "mode",
    "request_count",
    "concurrency",
    "successful_requests",
    "throughput_rps",
    "latency_p50_ms",
    "latency_p95_ms",
    "keycloak_calls",
    "keycloak_calls_per_request",
    "environment",
)
SERVICES = {
    "local": "api-local",
    "introspection": "api-introspection",
    "cached": "api-cached-introspection",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requests", type=int, default=1000)
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "results" / "bench.csv")
    return parser.parse_args()


def reset_metrics(service: str, secret: str) -> None:
    script = r"""
const response = await fetch("http://127.0.0.1:3000/internal/metrics/reset", {
  method: "POST",
  headers: {"x-benchmark-secret": process.env.BENCHMARK_API_SECRET},
});
if (response.status !== 204) process.exit(1);
"""
    environment = os.environ.copy()
    environment["BENCHMARK_API_SECRET"] = secret
    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            os.fspath(REPO_ROOT / "docker-compose.yml"),
            "-f",
            os.fspath(REPO_ROOT / "docker-compose.dev.yml"),
            "exec",
            "-T",
            "-e",
            "BENCHMARK_API_SECRET",
            service,
            "node",
            "-",
        ],
        cwd=REPO_ROOT,
        env=environment,
        input=script,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"could not reset metrics for {service}")


def main() -> int:
    args = parse_args()
    if args.requests < 1 or args.concurrency < 1 or args.concurrency > args.requests:
        raise ValueError(
            "requests and concurrency must be positive; concurrency cannot exceed requests"
        )
    client = LabClient()
    metadata = stable_json(environment_metadata())
    rows: list[dict[str, str | int]] = []
    try:
        secret = client.environment["BENCHMARK_API_SECRET"]
        for mode in MODES:
            reset_metrics(SERVICES[mode], secret)
            token = client.password_token("ali").access_token
            latencies, statuses, elapsed = benchmark_requests(
                lambda current_mode=mode, current_token=token: (
                    client.api(current_mode, "GET", "/documents/2", current_token).status_code
                ),
                request_count=args.requests,
                concurrency=args.concurrency,
            )
            successful = statuses.count(200)
            if successful != args.requests:
                raise RuntimeError(f"{mode} benchmark had {args.requests - successful} failures")
            metrics = client.api(mode, "GET", "/metrics").text
            keycloak_calls = parse_metric(
                metrics,
                "iam_api_keycloak_calls_total",
                {"operation": "introspection", "outcome": "success"},
            )
            rows.append(
                {
                    "mode": mode,
                    "request_count": args.requests,
                    "concurrency": args.concurrency,
                    "successful_requests": successful,
                    "throughput_rps": f"{args.requests / elapsed:.3f}",
                    "latency_p50_ms": f"{percentile(latencies, 0.50):.3f}",
                    "latency_p95_ms": f"{percentile(latencies, 0.95):.3f}",
                    "keycloak_calls": f"{keycloak_calls:.0f}",
                    "keycloak_calls_per_request": f"{keycloak_calls / args.requests:.6f}",
                    "environment": metadata,
                }
            )
    finally:
        client.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    staging = staging_path(args.output)
    with staging.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        handle.flush()
        os.fsync(handle.fileno())
    staging.replace(args.output)
    print(f"benchmark complete: {len(rows)} rows written to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
