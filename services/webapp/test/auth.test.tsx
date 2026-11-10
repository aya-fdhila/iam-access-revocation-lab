import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User, UserManager } from "oidc-client-ts";
import { describe, expect, it, vi } from "vitest";

import { AuthProvider, createUserManager, useAuth } from "../src/auth";

function LogoutProbe() {
  const auth = useAuth();
  if (auth.status !== "authenticated") return <span>{auth.status}</span>;
  return (
    <button onClick={() => void auth.logout()} type="button">
      Log out
    </button>
  );
}

describe("browser OAuth storage", () => {
  it("keeps processed user tokens out of persistent browser storage", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const manager = createUserManager("https://app.localhost");

    await manager.settings.userStore?.set("user-probe", "access-token-probe");

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(await manager.settings.userStore?.get("user-probe")).toBe("access-token-probe");
    expect(manager.settings.response_type).toBe("code");
    expect(manager.settings.scope).toBe("openid docs:read docs:write admin");
    expect(manager.settings.redirect_uri).toBe("https://app.localhost/callback");
    expect(manager.settings.automaticSilentRenew).toBe(true);
  });

  it("uses session storage only for the transient authorization transaction", async () => {
    sessionStorage.clear();
    const manager = createUserManager("https://app.localhost");
    await manager.settings.stateStore?.set("state-probe", "pkce-transaction-only");
    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
  });

  it("clears the local user and continues logout when revocation fails", async () => {
    const user = { access_token: "access", id_token: "identity", profile: {} } as User;
    const manager = {
      getUser: vi.fn().mockResolvedValue(user),
      revokeTokens: vi.fn().mockRejectedValue(new Error("revocation unavailable")),
      removeUser: vi.fn().mockResolvedValue(undefined),
      signoutRedirect: vi.fn().mockResolvedValue(undefined),
      events: {
        addUserLoaded: vi.fn(),
        addUserUnloaded: vi.fn(),
        removeUserLoaded: vi.fn(),
        removeUserUnloaded: vi.fn(),
      },
    } as unknown as UserManager;
    render(
      <AuthProvider manager={manager}>
        <LogoutProbe />
      </AuthProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Log out" }));

    await waitFor(() => expect(manager.removeUser).toHaveBeenCalledOnce());
    expect(manager.signoutRedirect).toHaveBeenCalledWith({ id_token_hint: "identity" });
    expect(screen.getByText("anonymous")).toBeInTheDocument();
  });
});
