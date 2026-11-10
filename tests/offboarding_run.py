#!/usr/bin/env python3
"""Measure residual access for baseline and automated employee offboarding."""

from __future__ import annotations

import argparse
import csv
import os
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from lab import MODES, REPO_ROOT, LabClient, run_offboarding, staging_path

FIELDNAMES = (
    "run_id",
    "repetition",
    "lifetime_s",
    "offboarding_mode",
    "validation_mode",
    "element",
    "t0",
    "t1",
    "observed_at",
    "delay_from_t0_s",
    "delay_from_t1_s",
    "outcome",
    "last_status",
    "detail",
)


@dataclass
class Observation:
    failed_at: float | None = None
    last_status: str = "not_checked"
    detail: str = "pending"


def iso_at(origin: datetime, elapsed: float) -> str:
    return (
        (origin + timedelta(seconds=elapsed))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lifetimes", type=int, nargs="+", default=[60, 300, 900])
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--t1-delay", type=float, default=2.0)
    parser.add_argument("--poll-interval", type=float, default=1.0)
    parser.add_argument("--grace", type=float, default=12.0)
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "results" / "offboarding.csv")
    return parser.parse_args()


def verify_preconditions(client: LabClient, access_token: str) -> None:
    failures = [
        mode
        for mode in MODES
        if client.api(mode, "GET", "/documents/3", access_token).status_code != 200
    ]
    if failures:
        raise RuntimeError(f"Marwa precondition failed in modes: {', '.join(failures)}")


def record_failure(observation: Observation, now: float, status: str, detail: str) -> None:
    if observation.failed_at is None:
        observation.failed_at = now
        observation.last_status = status
        observation.detail = detail


def run_one(
    client: LabClient,
    *,
    lifetime: int,
    repetition: int,
    offboarding_mode: str,
    t1_delay: float,
    poll_interval: float,
    grace: float,
) -> list[dict[str, str | int]]:
    run_id = f"{offboarding_mode}-{lifetime}-{repetition}-{uuid.uuid4().hex[:8]}"
    run_offboarding(
        user="marwa", mode=offboarding_mode, phase="restore", correlation_id=f"{run_id}-prepare"
    )
    time.sleep(2)
    token_pair = client.password_token("marwa")
    verify_preconditions(client, token_pair.access_token)

    observations = {
        ("identity", "new_login"): Observation(last_status="200", detail="login_succeeded"),
        ("identity", "refresh_chain"): Observation(
            last_status="not_checked", detail="first_checked_at_t1"
        ),
        **{
            (mode, element): Observation(last_status="200", detail="access_accepted")
            for mode in MODES
            for element in ("api_authenticated", "api_document_access")
        },
    }
    current_refresh = token_pair.refresh_token
    wall_origin = datetime.now(UTC)
    monotonic_origin = time.monotonic()
    t0 = 0.0
    run_offboarding(user="marwa", mode=offboarding_mode, phase="t0", correlation_id=f"{run_id}-t0")
    t1: float | None = None
    deadline = lifetime + grace
    next_poll = 0.0

    try:
        while True:
            now = time.monotonic() - monotonic_origin
            if t1 is None and now >= t1_delay:
                t1 = now
                run_offboarding(
                    user="marwa",
                    mode=offboarding_mode,
                    phase="t1",
                    correlation_id=f"{run_id}-t1",
                    refresh_token=current_refresh if offboarding_mode == "automated" else None,
                )
                now = time.monotonic() - monotonic_origin

            if now >= next_poll:
                try:
                    client.password_token("marwa")
                    observations[("identity", "new_login")].last_status = "200"
                except httpx.HTTPStatusError as error:
                    record_failure(
                        observations[("identity", "new_login")],
                        now,
                        str(error.response.status_code),
                        "password_grant_rejected",
                    )

                if t1 is not None and observations[("identity", "refresh_chain")].failed_at is None:
                    refreshed = client.refresh(current_refresh)
                    if refreshed is None:
                        record_failure(
                            observations[("identity", "refresh_chain")],
                            now,
                            "400",
                            "refresh_rejected",
                        )
                    else:
                        current_refresh = refreshed.refresh_token
                        observations[("identity", "refresh_chain")].last_status = "200"
                        observations[("identity", "refresh_chain")].detail = "refresh_chain_active"

                for mode in MODES:
                    for element, path in (
                        ("api_authenticated", "/me"),
                        ("api_document_access", "/documents/3"),
                    ):
                        observation = observations[(mode, element)]
                        if observation.failed_at is not None:
                            continue
                        response = client.api(mode, "GET", path, token_pair.access_token)
                        observation.last_status = str(response.status_code)
                        if response.status_code != 200:
                            detail = (
                                "old_access_token_rejected"
                                if response.status_code == 401
                                else "document_authorization_removed"
                            )
                            record_failure(observation, now, str(response.status_code), detail)
                next_poll += poll_interval

            if all(observation.failed_at is not None for observation in observations.values()):
                break
            if now >= deadline:
                break
            time.sleep(min(0.1, max(0.0, next_poll - (time.monotonic() - monotonic_origin))))
    finally:
        run_offboarding(
            user="marwa", mode=offboarding_mode, phase="restore", correlation_id=f"{run_id}-restore"
        )

    if t1 is None:
        raise RuntimeError("T1 was never applied")
    rows: list[dict[str, str | int]] = []
    for (validation_mode, element), observation in observations.items():
        observed_at = observation.failed_at
        outcome = "observed" if observed_at is not None else "censored"
        rows.append(
            {
                "run_id": run_id,
                "repetition": repetition,
                "lifetime_s": lifetime,
                "offboarding_mode": offboarding_mode,
                "validation_mode": validation_mode,
                "element": element,
                "t0": iso_at(wall_origin, t0),
                "t1": iso_at(wall_origin, t1),
                "observed_at": "" if observed_at is None else iso_at(wall_origin, observed_at),
                "delay_from_t0_s": "" if observed_at is None else f"{observed_at - t0:.3f}",
                "delay_from_t1_s": "" if observed_at is None else f"{observed_at - t1:.3f}",
                "outcome": outcome,
                "last_status": observation.last_status,
                "detail": observation.detail if observed_at is not None else "deadline_reached",
            }
        )
    return rows


def main() -> int:
    args = parse_args()
    project_name = os.environ.get("COMPOSE_PROJECT_NAME", "")
    if not project_name.startswith("iam-m6-"):
        raise RuntimeError(
            "COMPOSE_PROJECT_NAME must start with 'iam-m6-' so measurements cannot mutate "
            "the default stack"
        )
    if args.repetitions < 1 or any(lifetime < 10 for lifetime in args.lifetimes):
        raise ValueError("lifetimes must be at least 10 seconds and repetitions must be positive")
    client = LabClient()
    rows: list[dict[str, str | int]] = []
    try:
        for lifetime in args.lifetimes:
            client.set_access_token_lifespan(lifetime)
            for repetition in range(1, args.repetitions + 1):
                for offboarding_mode in ("baseline", "automated"):
                    print(
                        f"running {offboarding_mode} lifetime={lifetime}s repetition={repetition}",
                        flush=True,
                    )
                    rows.extend(
                        run_one(
                            client,
                            lifetime=lifetime,
                            repetition=repetition,
                            offboarding_mode=offboarding_mode,
                            t1_delay=args.t1_delay,
                            poll_interval=args.poll_interval,
                            grace=args.grace,
                        )
                    )
    finally:
        try:
            client.set_access_token_lifespan(300)
        finally:
            try:
                run_offboarding(
                    user="marwa",
                    mode="automated",
                    phase="restore",
                    correlation_id="experiment-final-restore",
                )
            finally:
                client.close()

    expected_rows = len(args.lifetimes) * args.repetitions * 2 * 8
    if len(rows) != expected_rows:
        raise RuntimeError(f"expected {expected_rows} rows, produced {len(rows)}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    staging = staging_path(args.output)
    with staging.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        handle.flush()
        os.fsync(handle.fileno())
    staging.replace(args.output)
    print(f"offboarding evidence complete: {len(rows)} rows written to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
