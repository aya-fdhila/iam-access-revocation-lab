"""Shared live-lab client helpers; tokens remain memory-only."""

from __future__ import annotations

import json
import math
import os
import ssl
import subprocess
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parents[1]
CERTIFICATE = REPO_ROOT / "infra" / "certs" / "localhost.pem"
MODES = ("local", "introspection", "cached")


def load_env(path: Path = REPO_ROOT / ".env") -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int


class LabClient:
    def __init__(
        self,
        environment: dict[str, str] | None = None,
        *,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.environment = environment or load_env()
        self.http = http_client or httpx.Client(
            verify=ssl.create_default_context(cafile=str(CERTIFICATE)), timeout=10
        )
        self._admin_token: str | None = None

    def close(self) -> None:
        self.http.close()

    def password_token(self, username: str, *, scope: str | None = None) -> TokenPair:
        data = {
            "grant_type": "password",
            "client_id": "test-cli",
            "username": username,
            "password": self.environment["LDAP_USER_PASSWORD"],
        }
        if scope is not None:
            data["scope"] = scope
        response = self.http.post(
            "https://auth.localhost/realms/company/protocol/openid-connect/token", data=data
        )
        response.raise_for_status()
        body = response.json()
        return TokenPair(body["access_token"], body["refresh_token"], body["expires_in"])

    def refresh(self, token: str) -> TokenPair | None:
        response = self.http.post(
            "https://auth.localhost/realms/company/protocol/openid-connect/token",
            data={"grant_type": "refresh_token", "client_id": "test-cli", "refresh_token": token},
        )
        if response.status_code != 200:
            return None
        body = response.json()
        return TokenPair(body["access_token"], body["refresh_token"], body["expires_in"])

    def api(
        self,
        mode: str,
        method: str,
        path: str,
        token: str | None = None,
        *,
        json_body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        headers = {} if token is None else {"authorization": f"Bearer {token}"}
        return self.http.request(
            method,
            f"https://api.localhost/{mode}{path}",
            headers=headers,
            json=json_body,
        )

    def job_token(self) -> str:
        response = self.http.post(
            "https://auth.localhost/realms/company/protocol/openid-connect/token",
            data={
                "grant_type": "client_credentials",
                "client_id": "job",
                "client_secret": self.environment["JOB_CLIENT_SECRET"],
            },
        )
        response.raise_for_status()
        return str(response.json()["access_token"])

    def admin_token(self) -> str:
        if self._admin_token is None:
            response = self.http.post(
                "https://auth.localhost/realms/master/protocol/openid-connect/token",
                data={
                    "grant_type": "password",
                    "client_id": "admin-cli",
                    "username": self.environment.get("KC_ADMIN", "admin"),
                    "password": self.environment["KC_ADMIN_PASSWORD"],
                },
            )
            response.raise_for_status()
            self._admin_token = str(response.json()["access_token"])
        return self._admin_token

    def set_access_token_lifespan(self, seconds: int) -> None:
        self._realm_request("PUT", json_body={"accessTokenLifespan": seconds})

    def access_token_lifespan(self) -> int:
        return int(self._realm_request("GET").json()["accessTokenLifespan"])

    def _realm_request(
        self, method: str, *, json_body: dict[str, int] | None = None
    ) -> httpx.Response:
        for attempt in range(2):
            response = self.http.request(
                method,
                "https://admin-auth.localhost/admin/realms/company",
                headers={"authorization": f"Bearer {self.admin_token()}"},
                json=json_body,
            )
            if response.status_code != 401 or attempt == 1:
                response.raise_for_status()
                return response
            self._admin_token = None
        raise RuntimeError("unreachable admin-token retry state")

    def wrong_audience_token(self) -> str:
        response = self.http.post(
            "https://auth.localhost/realms/company/protocol/openid-connect/token",
            data={
                "grant_type": "password",
                "client_id": "admin-cli",
                "username": "ali",
                "password": self.environment["LDAP_USER_PASSWORD"],
            },
        )
        response.raise_for_status()
        return str(response.json()["access_token"])


def run_offboarding(
    *,
    user: str,
    mode: str,
    phase: str,
    correlation_id: str,
    refresh_token: str | None = None,
) -> None:
    command = [
        os.fspath(REPO_ROOT / ".venv" / "bin" / "python"),
        "-m",
        "services.offboarding.cli",
        "--user",
        user,
        "--mode",
        mode,
        "--phase",
        phase,
        "--correlation-id",
        correlation_id,
    ]
    if refresh_token is not None:
        command.append("--refresh-token-stdin")
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        input=refresh_token,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"offboarding {phase} failed: {result.stderr.strip()}")


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        raise ValueError("at least one sample is required")
    ordered = sorted(values)
    index = max(0, math.ceil(quantile * len(ordered)) - 1)
    return ordered[index]


def parse_metric(body: str, name: str, labels: dict[str, str] | None = None) -> float:
    labels = labels or {}
    total = 0.0
    for line in body.splitlines():
        if not line.startswith(name):
            continue
        metric, raw_value = line.rsplit(" ", 1)
        if all(f'{key}="{value}"' in metric for key, value in labels.items()):
            total += float(raw_value)
    return total


def benchmark_requests(
    operation: Callable[[], int], *, request_count: int, concurrency: int
) -> tuple[list[float], list[int], float]:
    def measured() -> tuple[float, int]:
        started = time.perf_counter()
        status = operation()
        return (time.perf_counter() - started) * 1000, status

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        samples = list(executor.map(lambda _: measured(), range(request_count)))
    elapsed = time.perf_counter() - started
    return [sample[0] for sample in samples], [sample[1] for sample in samples], elapsed


def environment_metadata() -> dict[str, str]:
    docker = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    return {
        "cpu_count": str(os.cpu_count() or "unknown"),
        "docker_server": docker,
        "python": ".".join(map(str, os.sys.version_info[:3])),
        "platform": os.uname().sysname + " " + os.uname().release,
    }


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def staging_path(output: Path) -> Path:
    return output.with_name(f"{output.name}.tmp.{os.getpid()}")
