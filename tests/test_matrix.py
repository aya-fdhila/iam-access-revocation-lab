#!/usr/bin/env python3
"""Execute the declared external authorization matrix and write normalized CSV."""

from __future__ import annotations

import argparse
import base64
import csv
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
from lab import MODES, REPO_ROOT, LabClient, staging_path


@dataclass(frozen=True)
class Profile:
    profile: str
    token_name: str | None


@dataclass(frozen=True)
class RouteCase:
    name: str
    method: str
    route: str


PROFILES = (
    Profile("anonymous", None),
    Profile("ali_employee", "ali"),
    Profile("marwa_employee_owner", "marwa"),
    Profile("marwen_manager", "marwen"),
    Profile("aya_admin", "aya"),
    Profile("yassmine_admin", "yassmine"),
    Profile("job_service", "job"),
)

ROUTES = (
    RouteCase("health", "GET", "/health"),
    RouteCase("identity", "GET", "/me"),
    RouteCase("document_list", "GET", "/documents"),
    RouteCase("marwa_document", "GET", "/documents/3"),
    RouteCase("document_create", "POST", "/documents"),
    RouteCase("ali_document_delete", "DELETE", "/documents/:id"),
    RouteCase("admin_users", "GET", "/admin/users"),
    RouteCase("scheduled_report", "POST", "/reports/run"),
)

NEGATIVE_CASES = (
    ("tampered_signature", "tampered"),
    ("wrong_audience", "wrong_audience"),
    ("expired_token", "expired"),
)

FIELDNAMES = (
    "case_type",
    "profile",
    "route",
    "method",
    "mode",
    "expected_status",
    "obtained_status",
    "latency_ms",
    "outcome",
)


def expected_status(profile: str, route: str) -> int:
    if route == "health":
        return 200
    if profile == "anonymous":
        return 401
    if route == "identity":
        return 200
    if route == "document_list":
        return 403 if profile == "job_service" else 200
    if route == "marwa_document":
        return (
            200
            if profile in {"marwa_employee_owner", "marwen_manager", "aya_admin", "yassmine_admin"}
            else 403
        )
    if route == "document_create":
        return 403 if profile == "job_service" else 201
    if route == "ali_document_delete":
        return 204 if profile in {"ali_employee", "aya_admin", "yassmine_admin"} else 403
    if route == "admin_users":
        return 200 if profile in {"aya_admin", "yassmine_admin"} else 403
    if route == "scheduled_report":
        return 200 if profile == "job_service" else 403
    raise ValueError(f"unknown matrix route: {route}")


def request_route(
    client: LabClient,
    *,
    mode: str,
    profile: Profile,
    route: RouteCase,
    tokens: dict[str, str],
) -> tuple[str, httpx.Response]:
    token = None if profile.token_name is None else tokens[profile.token_name]
    if route.name == "document_create":
        response = client.api(
            mode,
            route.method,
            route.route,
            token,
            json_body={"title": f"matrix-create-{mode}-{profile.profile}"},
        )
        if response.status_code == 201:
            document_id = int(response.json()["id"])
            cleanup = client.api(mode, "DELETE", f"/documents/{document_id}", token)
            if cleanup.status_code != 204:
                raise RuntimeError(f"matrix create cleanup failed with HTTP {cleanup.status_code}")
        return route.route, response
    if route.name != "ali_document_delete":
        return route.route, client.api(mode, route.method, route.route, token)

    created = client.api(
        mode,
        "POST",
        "/documents",
        tokens["ali"],
        json_body={"title": f"matrix-delete-{mode}-{profile.profile}"},
    )
    if created.status_code != 201:
        raise RuntimeError(f"matrix delete setup failed with HTTP {created.status_code}")
    document_id = int(created.json()["id"])
    response = client.api(mode, "DELETE", f"/documents/{document_id}", token)
    if response.status_code != 204:
        cleanup = client.api(mode, "DELETE", f"/documents/{document_id}", tokens["aya"])
        if cleanup.status_code != 204:
            raise RuntimeError(f"matrix delete cleanup failed with HTTP {cleanup.status_code}")
    return route.route, response


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "results" / "matrix.csv")
    return parser.parse_args()


def token_expiration(token: str) -> int:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return int(json.loads(base64.urlsafe_b64decode(payload))["exp"])


def real_expired_token(client: LabClient) -> str:
    original_lifespan = client.access_token_lifespan()
    try:
        client.set_access_token_lifespan(1)
        token = client.password_token("ali").access_token
    finally:
        client.set_access_token_lifespan(original_lifespan)
    wait_seconds = max(0.0, token_expiration(token) + 6 - time.time())
    time.sleep(wait_seconds)
    return token


def main() -> int:
    args = parse_args()
    client = LabClient()
    try:
        ali = client.password_token("ali").access_token
        tokens = {
            "ali": ali,
            "marwa": client.password_token("marwa").access_token,
            "marwen": client.password_token("marwen").access_token,
            "aya": client.password_token("aya", scope="openid admin").access_token,
            "yassmine": client.password_token("yassmine", scope="openid admin").access_token,
            "job": client.job_token(),
            "tampered": f"{ali}x",
            "wrong_audience": client.wrong_audience_token(),
            "expired": real_expired_token(client),
        }
        rows: list[dict[str, str | int]] = []
        failures = 0
        for mode in MODES:
            for profile in PROFILES:
                for route in ROUTES:
                    expected = expected_status(profile.profile, route.name)
                    started = time.perf_counter()
                    recorded_route, response = request_route(
                        client,
                        mode=mode,
                        profile=profile,
                        route=route,
                        tokens=tokens,
                    )
                    latency_ms = (time.perf_counter() - started) * 1000
                    outcome = "pass" if response.status_code == expected else "fail"
                    failures += outcome == "fail"
                    rows.append(
                        {
                            "case_type": "policy",
                            "profile": profile.profile,
                            "route": recorded_route,
                            "method": route.method,
                            "mode": mode,
                            "expected_status": expected,
                            "obtained_status": response.status_code,
                            "latency_ms": f"{latency_ms:.3f}",
                            "outcome": outcome,
                        }
                    )
            for profile, token_name in NEGATIVE_CASES:
                started = time.perf_counter()
                response = client.api(mode, "GET", "/me", tokens[token_name])
                latency_ms = (time.perf_counter() - started) * 1000
                outcome = "pass" if response.status_code == 401 else "fail"
                failures += outcome == "fail"
                rows.append(
                    {
                        "case_type": "token_validation",
                        "profile": profile,
                        "route": "/me",
                        "method": "GET",
                        "mode": mode,
                        "expected_status": 401,
                        "obtained_status": response.status_code,
                        "latency_ms": f"{latency_ms:.3f}",
                        "outcome": outcome,
                    }
                )
        expected_rows = len(MODES) * (len(PROFILES) * len(ROUTES) + len(NEGATIVE_CASES))
        if len(rows) != expected_rows:
            raise RuntimeError("authorization matrix was incomplete")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        staging = staging_path(args.output)
        with staging.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDNAMES, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
            handle.flush()
            os.fsync(handle.fileno())
        if failures:
            staging.unlink(missing_ok=True)
            raise RuntimeError(f"authorization matrix had {failures} mismatches")
        staging.replace(args.output)
        print(f"authorization matrix passed: {len(rows)} rows written to {args.output}")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
