import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User } from "oidc-client-ts";
import { describe, expect, it, vi } from "vitest";

import { SecurityConsole } from "../src/App";
import type { AuthState } from "../src/auth";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function authenticated(
  roles: string[] = ["employees"],
  scopes: string[] = ["docs:read", "docs:write"],
): AuthState {
  return {
    status: "authenticated",
    error: null,
    user: {
      access_token: jwt({
        preferred_username: "ali",
        email: "ali@iam.localhost",
        realm_access: { roles },
        scope: scopes.join(" "),
        azp: "webapp",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
      id_token: jwt({ preferred_username: "ali", name: "Ali Mansouri" }),
      refresh_token: "refresh-token-never-render",
      profile: { iss: "https://auth.localhost/realms/company", sub: "subject-ali" },
    } as User,
    login: vi.fn(),
    logout: vi.fn(),
  };
}

describe("security console", () => {
  it("shows identity, role, scope, client, expiry, and refresh evidence", () => {
    render(<SecurityConsole auth={authenticated()} />);
    expect(screen.getByRole("heading", { name: "Who am I?" })).toBeInTheDocument();
    expect(screen.getByText("ali@iam.localhost")).toBeInTheDocument();
    expect(screen.getByText("docs:read, docs:write")).toBeInTheDocument();
    expect(screen.getByText("active · memory only")).toBeInTheDocument();
  });

  it("offers PKCE sign-in without exposing a password field", async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    render(
      <SecurityConsole
        auth={{ status: "anonymous", user: null, error: null, login, logout: vi.fn() }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in with PKCE" }));
    expect(login).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it("distinguishes ID and access token claims without rendering raw tokens", async () => {
    const auth = authenticated();
    const rawAccessToken = auth.user?.access_token ?? "";
    render(<SecurityConsole auth={auth} />);
    await userEvent.click(screen.getByRole("button", { name: "Token inspector" }));
    expect(screen.getByRole("heading", { name: "ID token" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Access token" })).toBeInTheDocument();
    expect(screen.getByText("Browser sign-in identity")).toBeInTheDocument();
    expect(screen.getByText("API authorization evidence")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(rawAccessToken);
  });

  it("hides administration unless both the role and scope are present", () => {
    render(<SecurityConsole auth={authenticated()} />);
    expect(screen.queryByRole("button", { name: "Administration" })).not.toBeInTheDocument();
    cleanup();
    render(<SecurityConsole auth={authenticated(["admins"])} />);
    expect(screen.queryByRole("button", { name: "Administration" })).not.toBeInTheDocument();
    cleanup();
    render(<SecurityConsole auth={authenticated(["admins"], ["docs:read", "admin"])} />);
    expect(screen.getByRole("button", { name: "Administration" })).toBeInTheDocument();
  });

  it("renders document loading and success states", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingResponse));
    render(<SecurityConsole auth={authenticated()} />);
    await userEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(screen.getByRole("status")).toHaveTextContent("Checking");
    resolveResponse?.(
      new Response(
        JSON.stringify({
          documents: [{ id: 2, owner: "ali", title: "Employee access guide" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await waitFor(() => expect(screen.getByText("Employee access guide")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      "https://api.localhost/local/documents",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: expect.stringMatching(/^Bearer /) }),
      }),
    );
  });

  it("renders a network-error state with recovery direction", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<SecurityConsole auth={authenticated()} />);
    await userEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("API unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("local stack is running");
  });

  it.each([
    [401, "Authentication no longer valid"],
    [403, "Policy refused this action"],
  ])("renders a %s document refusal", async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "refused" } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<SecurityConsole auth={authenticated()} />);
    await userEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("renders the document empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ documents: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<SecurityConsole auth={authenticated()} />);
    await userEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(
      await screen.findByText("No documents are visible to this identity."),
    ).toBeInTheDocument();
  });

  it("views and deletes a document with decision evidence", async () => {
    const document = { id: 2, owner: "ali", title: "Employee access guide" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ documents: [document] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(document), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    render(<SecurityConsole auth={authenticated()} />);
    await userEvent.click(screen.getByRole("button", { name: "Documents" }));
    await userEvent.click(await screen.findByRole("button", { name: "View" }));
    expect(screen.getByLabelText("Selected document")).toHaveTextContent("Employee access guide");
    await userEvent.click(screen.getByRole("button", { name: "Delete document" }));
    await waitFor(() =>
      expect(screen.queryByText("Employee access guide")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("204")).toBeInTheDocument();
  });

  it("creates a document and records the 201 decision", async () => {
    const created = { id: 4, owner: "ali", title: "Quarterly access review" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ documents: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(created), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    render(<SecurityConsole auth={authenticated()} />);
    await userEvent.click(screen.getByRole("button", { name: "Documents" }));
    await userEvent.type(await screen.findByLabelText("New document title"), created.title);
    await userEvent.click(screen.getByRole("button", { name: "Create document" }));
    expect(await screen.findAllByText(created.title)).toHaveLength(2);
    expect(screen.getByText("201")).toBeInTheDocument();
  });

  it("keeps the privileged offboarding workflow out of the browser", async () => {
    render(<SecurityConsole auth={authenticated(["admins"], ["admin"])} />);
    await userEvent.click(screen.getByRole("button", { name: "Offboarding horizon" }));
    expect(screen.getByRole("button", { name: /host CLI only/ })).toBeDisabled();
  });
});
