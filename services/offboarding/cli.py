#!/usr/bin/env python3
# ruff: noqa: E501
"""Run retry-safe LDAP, Keycloak, and API offboarding mutations."""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENV_FILE = REPO_ROOT / ".env"
DEFAULT_RECEIPT_DIR = REPO_ROOT / "results" / "raw" / "offboarding-receipts"
USERNAME_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
CORRELATION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MODES = ("baseline", "automated")
PHASES = ("t0", "t1", "full", "restore")
OFFBOARDING_SUBJECTS = frozenset({"marwa"})


class WorkflowError(RuntimeError):
    """A fail-loud offboarding mutation error."""


@dataclass(frozen=True)
class Receipt:
    correlation_id: str
    user: str
    mode: str
    phase: str
    step: str
    started_at: str
    finished_at: str
    outcome: str
    detail: str


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_env(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise WorkflowError(f"Missing environment file: {path}. Run make secrets first.")
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    return values


def require_secret(environment: dict[str, str], key: str) -> str:
    value = environment.get(key, "")
    if not value or value == "replace-with-generated-secret":
        raise WorkflowError(f"{key} is not generated. Run make secrets first.")
    return value


class ReceiptWriter:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, receipt: Receipt) -> None:
        line = json.dumps(asdict(receipt), sort_keys=True, separators=(",", ":"))
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(f"{line}\n")
            handle.flush()
            os.fsync(handle.fileno())


class HttpClient:
    def __init__(self, certificate: Path) -> None:
        if not certificate.is_file():
            raise WorkflowError(f"Missing TLS certificate: {certificate}. Run make certs first.")
        self.context = ssl.create_default_context(cafile=str(certificate))

    def request(
        self,
        method: str,
        url: str,
        *,
        form: dict[str, str] | None = None,
        json_body: dict[str, Any] | None = None,
        bearer: str | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> tuple[int, bytes]:
        data: bytes | None = None
        headers = {"accept": "application/json"}
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers["content-type"] = "application/x-www-form-urlencoded"
        if json_body is not None:
            data = json.dumps(json_body, separators=(",", ":")).encode()
            headers["content-type"] = "application/json"
        if bearer is not None:
            headers["authorization"] = f"Bearer {bearer}"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=10) as response:
                status = response.status
                body = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            body = error.read()
        except (OSError, TimeoutError) as error:
            raise WorkflowError(f"HTTP dependency unavailable for {method} {url}") from error
        if status not in expected:
            raise WorkflowError(f"Unexpected HTTP {status} for {method} {url}")
        return status, body


class OffboardingWorkflow:
    def __init__(
        self,
        *,
        user: str,
        mode: str,
        phase: str,
        environment: dict[str, str],
        receipt_writer: ReceiptWriter,
        correlation_id: str,
        refresh_token: str | None,
        http_client: HttpClient,
    ) -> None:
        if USERNAME_PATTERN.fullmatch(user) is None:
            raise WorkflowError("USER must be a lowercase laboratory username.")
        if user not in OFFBOARDING_SUBJECTS:
            raise WorkflowError(
                "USER must be the designated laboratory offboarding subject: marwa."
            )
        if mode not in MODES:
            raise WorkflowError(f"Unsupported mode: {mode}")
        if phase not in PHASES:
            raise WorkflowError(f"Unsupported phase: {phase}")
        if CORRELATION_PATTERN.fullmatch(correlation_id) is None:
            raise WorkflowError("Correlation ID contains unsupported path characters.")
        self.user = user
        self.mode = mode
        self.phase = phase
        self.environment = environment
        self.receipts = receipt_writer
        self.correlation_id = correlation_id
        self.refresh_token = refresh_token
        self.http = http_client
        self._admin_token: str | None = None
        self._keycloak_user: dict[str, Any] | None = None

    def run(self) -> None:
        if self.phase == "restore":
            self._step("ldap_add_employee", self._ldap_add_employee)
            self._step("ldap_unlock", self._ldap_unlock)
            self._step("keycloak_enable", lambda: self._keycloak_set_enabled(True))
            self._step("keycloak_logout", self._keycloak_logout)
            return
        if self.phase in ("t0", "full"):
            self._step("ldap_remove_groups", self._ldap_remove_groups)
        if self.phase in ("t1", "full"):
            self._step("ldap_lock", self._ldap_lock)
            if self.mode == "automated":
                self._step("keycloak_disable", lambda: self._keycloak_set_enabled(False))
                self._step("keycloak_logout", self._keycloak_logout)
                if self.refresh_token is None:
                    self._record("refresh_token_revoke", "skipped", "no_known_refresh_token")
                else:
                    self._step("refresh_token_revoke", self._revoke_refresh_token)
                self._step("local_not_before", self._set_not_before)

    def _step(self, name: str, operation: Any) -> None:
        started = utc_now()
        try:
            outcome, detail = operation()
        except Exception as error:
            finished = utc_now()
            self.receipts.append(
                Receipt(
                    self.correlation_id,
                    self.user,
                    self.mode,
                    self.phase,
                    name,
                    started,
                    finished,
                    "failed",
                    type(error).__name__,
                )
            )
            raise
        self.receipts.append(
            Receipt(
                self.correlation_id,
                self.user,
                self.mode,
                self.phase,
                name,
                started,
                utc_now(),
                outcome,
                detail,
            )
        )

    def _record(self, name: str, outcome: str, detail: str) -> None:
        now = utc_now()
        self.receipts.append(
            Receipt(
                self.correlation_id,
                self.user,
                self.mode,
                self.phase,
                name,
                now,
                now,
                outcome,
                detail,
            )
        )

    def _compose(
        self,
        service: str,
        script: str,
        *,
        extra_env: dict[str, str],
        interpreter: tuple[str, ...] = ("sh", "-eu"),
    ) -> str:
        command = [
            "docker",
            "compose",
            "-f",
            str(REPO_ROOT / "docker-compose.yml"),
            "-f",
            str(REPO_ROOT / "docker-compose.dev.yml"),
            "exec",
            "-T",
        ]
        process_env = os.environ.copy()
        for key, value in extra_env.items():
            command.extend(("-e", key))
            process_env[key] = value
        command.append(service)
        command.extend(interpreter)
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=process_env,
            input=script,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            raise WorkflowError(f"Container mutation failed in {service}")
        return result.stdout.strip()

    def _ldap_script(self, action: str) -> tuple[str, str]:
        admin_password = require_secret(self.environment, "LDAP_ADMIN_PASSWORD")
        script = r"""
password_file="$(mktemp /tmp/offboard-password.XXXXXX)"
change_file="$(mktemp /tmp/offboard-change.XXXXXX)"
trap 'rm -f -- "$password_file" "$change_file"' EXIT
chmod 600 "$password_file"
printf '%s' "$LDAP_ADMIN_PASSWORD" >"$password_file"
user_dn="uid=$OFFBOARD_USER,ou=people,dc=iam,dc=localhost"
group_dn="cn=employees,ou=groups,dc=iam,dc=localhost"
case "$OFFBOARD_ACTION" in
  remove-groups)
    if ldapsearch -LLL -x -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -b "$group_dn" -s base "(member=$user_dn)" dn | grep -q '^dn:'; then
      printf 'dn: %s\nchangetype: modify\ndelete: member\nmember: %s\n' "$group_dn" "$user_dn" >"$change_file"
      ldapmodify -x -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -f "$change_file" >/dev/null
      printf changed
    else printf already_applied; fi
    ;;
  add-employee)
    if ldapsearch -LLL -x -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -b "$group_dn" -s base "(member=$user_dn)" dn | grep -q '^dn:'; then
      printf already_applied
    else
      printf 'dn: %s\nchangetype: modify\nadd: member\nmember: %s\n' "$group_dn" "$user_dn" >"$change_file"
      ldapmodify -x -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -f "$change_file" >/dev/null
      printf changed
    fi
    ;;
  lock)
    if ldapsearch -LLL -x -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -b "$user_dn" -s base '(pwdAccountLockedTime=*)' dn | grep -q '^dn:'; then
      printf already_applied
    else
      printf 'dn: %s\nchangetype: modify\nadd: pwdAccountLockedTime\npwdAccountLockedTime: 000001010000Z\n' "$user_dn" >"$change_file"
      ldapmodify -x -e relax -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -f "$change_file" >/dev/null
      printf changed
    fi
    ;;
  unlock)
    changed=false
    if ldapsearch -LLL -x -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -b "$user_dn" -s base '(pwdAccountLockedTime=*)' dn | grep -q '^dn:'; then
      printf 'dn: %s\nchangetype: modify\ndelete: pwdAccountLockedTime\n' "$user_dn" >"$change_file"
      ldapmodify -x -e relax -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -f "$change_file" >/dev/null
      changed=true
    fi
    if ldapsearch -LLL -x -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -b "$user_dn" -s base '(pwdFailureTime=*)' dn | grep -q '^dn:'; then
      printf 'dn: %s\nchangetype: modify\ndelete: pwdFailureTime\n' "$user_dn" >"$change_file"
      ldapmodify -x -e relax -H ldap://127.0.0.1:1389 -D 'cn=admin,dc=iam,dc=localhost' -y "$password_file" -f "$change_file" >/dev/null
      changed=true
    fi
    if [ "$changed" = true ]; then printf changed; else printf already_applied; fi
    ;;
esac
"""
        output = self._compose(
            "ldap",
            script,
            extra_env={
                "LDAP_ADMIN_PASSWORD": admin_password,
                "OFFBOARD_ACTION": action,
                "OFFBOARD_USER": self.user,
            },
        )
        return output, action.replace("-", "_")

    def _ldap_remove_groups(self) -> tuple[str, str]:
        return self._ldap_script("remove-groups")

    def _ldap_add_employee(self) -> tuple[str, str]:
        return self._ldap_script("add-employee")

    def _ldap_lock(self) -> tuple[str, str]:
        return self._ldap_script("lock")

    def _ldap_unlock(self) -> tuple[str, str]:
        return self._ldap_script("unlock")

    def _get_admin_token(self) -> str:
        if self._admin_token is None:
            _, body = self.http.request(
                "POST",
                "https://auth.localhost/realms/master/protocol/openid-connect/token",
                form={
                    "grant_type": "password",
                    "client_id": "admin-cli",
                    "username": self.environment.get("KC_ADMIN", "admin"),
                    "password": require_secret(self.environment, "KC_ADMIN_PASSWORD"),
                },
            )
            try:
                self._admin_token = str(json.loads(body)["access_token"])
            except (KeyError, TypeError, json.JSONDecodeError) as error:
                raise WorkflowError("Keycloak admin token response was invalid") from error
        return self._admin_token

    def _get_keycloak_user(self) -> dict[str, Any]:
        if self._keycloak_user is None:
            query = urllib.parse.urlencode({"username": self.user, "exact": "true"})
            _, body = self.http.request(
                "GET",
                f"https://admin-auth.localhost/admin/realms/company/users?{query}",
                bearer=self._get_admin_token(),
            )
            users = json.loads(body)
            if not isinstance(users, list) or len(users) != 1:
                raise WorkflowError("Expected exactly one Keycloak user")
            self._keycloak_user = users[0]
        return self._keycloak_user

    def _keycloak_set_enabled(self, enabled: bool) -> tuple[str, str]:
        user = self._get_keycloak_user()
        if user.get("enabled") is enabled:
            return "already_applied", "enabled" if enabled else "disabled"
        self.http.request(
            "PUT",
            f"https://admin-auth.localhost/admin/realms/company/users/{user['id']}",
            json_body={"enabled": enabled},
            bearer=self._get_admin_token(),
            expected=(204,),
        )
        user["enabled"] = enabled
        return "changed", "enabled" if enabled else "disabled"

    def _keycloak_logout(self) -> tuple[str, str]:
        user = self._get_keycloak_user()
        self.http.request(
            "POST",
            f"https://admin-auth.localhost/admin/realms/company/users/{user['id']}/logout",
            bearer=self._get_admin_token(),
            expected=(204,),
        )
        return "succeeded", "sessions_invalidated"

    def _revoke_refresh_token(self) -> tuple[str, str]:
        assert self.refresh_token is not None
        self.http.request(
            "POST",
            "https://auth.localhost/realms/company/protocol/openid-connect/revoke",
            form={
                "client_id": "test-cli",
                "token": self.refresh_token,
                "token_type_hint": "refresh_token",
            },
            expected=(200,),
        )
        return "succeeded", "rfc7009"

    def _set_not_before(self) -> tuple[str, str]:
        cutoff = int(time.time()) + 1
        secret = require_secret(self.environment, "OFFBOARDING_API_SECRET")
        script = f"""
const response = await fetch("http://127.0.0.1:3000/internal/not-before/{self.user}", {{
  method: "PUT",
  headers: {{"content-type": "application/json", "x-offboarding-secret": process.env.OFFBOARDING_API_SECRET}},
  body: JSON.stringify({{timestamp: {cutoff}}}),
}});
if (!response.ok) process.exit(1);
const body = await response.json();
process.stdout.write(String(body.notBefore));
"""
        applied = self._compose(
            "api-local",
            script,
            extra_env={"OFFBOARDING_API_SECRET": secret},
            interpreter=("node", "-"),
        )
        outcome = "changed" if int(applied) == cutoff else "already_applied"
        return outcome, "monotonic_cutoff_applied"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", required=True)
    parser.add_argument("--mode", choices=MODES, default="automated")
    parser.add_argument("--phase", choices=PHASES, default="full")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--receipt-dir", type=Path, default=DEFAULT_RECEIPT_DIR)
    parser.add_argument("--correlation-id", default=str(uuid.uuid4()))
    parser.add_argument("--refresh-token-stdin", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if CORRELATION_PATTERN.fullmatch(args.correlation_id) is None:
        raise WorkflowError("Correlation ID contains unsupported path characters.")
    refresh_token = None
    if args.refresh_token_stdin:
        refresh_token = sys.stdin.read().strip()
        if not refresh_token:
            raise WorkflowError("--refresh-token-stdin requires a token on standard input")
    receipt_path = args.receipt_dir / f"{args.correlation_id}.jsonl"
    workflow = OffboardingWorkflow(
        user=args.user,
        mode=args.mode,
        phase=args.phase,
        environment=load_env(args.env_file),
        receipt_writer=ReceiptWriter(receipt_path),
        correlation_id=args.correlation_id,
        refresh_token=refresh_token,
        http_client=HttpClient(REPO_ROOT / "infra" / "certs" / "localhost.pem"),
    )
    workflow.run()
    print(
        json.dumps(
            {"correlation_id": args.correlation_id, "receipt": str(receipt_path), "status": "ok"},
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except WorkflowError as error:
        print(f"offboarding failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
