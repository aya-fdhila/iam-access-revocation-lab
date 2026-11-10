from __future__ import annotations

import httpx

from tests.lab import LabClient


def test_realm_update_renews_expired_admin_token() -> None:
    authorizations: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"access_token": "fresh-admin-token"})
        authorizations.append(request.headers["authorization"])
        return httpx.Response(401 if len(authorizations) == 1 else 204)

    client = LabClient(
        {"KC_ADMIN": "admin", "KC_ADMIN_PASSWORD": "secret", "LDAP_USER_PASSWORD": "secret"},
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    client._admin_token = "expired-admin-token"
    try:
        client.set_access_token_lifespan(300)
    finally:
        client.close()
    assert authorizations == ["Bearer expired-admin-token", "Bearer fresh-admin-token"]
