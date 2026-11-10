import { type FormEvent, useEffect, useState } from "react";

import {
  ApiRequestError,
  type ApiResult,
  apiRequest,
  apiRequestDetailed,
  type ValidationMode,
  validationModes,
} from "./api";
import { type AuthState, useAuth } from "./auth";
import {
  decodeJwt,
  decodeJwtPart,
  type JsonClaims,
  spaceDelimitedClaim,
  stringArrayClaim,
  tokenFingerprint,
} from "./tokens";

type Page = "dashboard" | "tokens" | "documents" | "offboarding" | "admin";
type AsyncState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: T }
  | { kind: "error"; error: ApiRequestError };
type DocumentRecord = { id: number; owner: string; title: string };
type MatrixResult = { mode: ValidationMode; route: string; status: number; latency: number };

const pageLabels: Record<Page, string> = {
  dashboard: "Decision matrix",
  tokens: "Token inspector",
  documents: "Documents",
  offboarding: "Offboarding horizon",
  admin: "Administration",
};

function StatusPanel({ state }: { state: AsyncState<unknown> }) {
  if (state.kind === "idle") return null;
  if (state.kind === "loading") {
    return (
      <div className="state-panel loading" role="status">
        Checking the selected validation path…
      </div>
    );
  }
  if (state.kind === "success") return null;
  const title =
    state.error.status === 0
      ? "API unavailable"
      : state.error.status === 401
        ? "Authentication no longer valid"
        : state.error.status === 403
          ? "Policy refused this action"
          : "Request failed";
  return (
    <div className="state-panel error" role="alert">
      <strong>{title}</strong>
      <span className="state-copy">{state.error.message}</span>
      <code>
        {state.error.status === 0 ? "network" : state.error.status} ·{" "}
        {state.error.latencyMs.toFixed(0)} ms
      </code>
    </div>
  );
}

function DecisionReceipt({ result }: { result: ApiResult<unknown> | null }) {
  if (result === null) return null;
  return (
    <div className="decision-receipt" role="status">
      <span>Last API decision</span>
      <b>{result.status}</b>
      <code>{result.latencyMs.toFixed(0)} ms</code>
    </div>
  );
}

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: ValidationMode;
  onChange: (mode: ValidationMode) => void;
}) {
  return (
    <fieldset className="mode-switch">
      <legend>Validation path</legend>
      {validationModes.map((candidate) => (
        <label key={candidate}>
          <input
            checked={candidate === mode}
            name="validation-mode"
            onChange={() => onChange(candidate)}
            type="radio"
          />
          <span>{candidate === "cached" ? "Cached introspection" : candidate}</span>
        </label>
      ))}
    </fieldset>
  );
}

function Dashboard({
  token,
  isAdmin,
  claims,
  hasRefreshToken,
}: {
  token: string;
  isAdmin: boolean;
  claims: JsonClaims | null;
  hasRefreshToken: boolean;
}) {
  const [matrix, setMatrix] = useState<AsyncState<MatrixResult[]>>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const expiresAt = typeof claims?.exp === "number" ? claims.exp * 1000 : null;
  const expiresIn =
    expiresAt === null ? "unknown" : `${Math.max(0, Math.ceil((expiresAt - now) / 1000))} s`;
  const roles = stringArrayClaim(claims, ["realm_access", "roles"]);
  const scopes = spaceDelimitedClaim(claims, "scope");
  const identityFacts = [
    [
      "Identity",
      typeof claims?.preferred_username === "string" ? claims.preferred_username : "unknown",
    ],
    ["Email", typeof claims?.email === "string" ? claims.email : "not included"],
    ["Client", typeof claims?.azp === "string" ? claims.azp : "unknown"],
    ["Roles", roles.join(", ") || "none"],
    ["Scopes", scopes.join(", ") || "none"],
    ["Token expires", expiresIn],
    ["Refresh rotation", hasRefreshToken ? "active · memory only" : "refresh token not issued"],
  ] as const;
  const runMatrix = async () => {
    setMatrix({ kind: "loading" });
    const probes = validationModes.flatMap((mode) => [
      { mode, route: "/me", method: "GET" },
      { mode, route: "/documents", method: "GET" },
      { mode, route: "/admin/users", method: "GET" },
    ]);
    const results = await Promise.all(
      probes.map(async (probe) => {
        const started = performance.now();
        try {
          await apiRequest(probe.mode, probe.route, token, { method: probe.method });
          return { ...probe, status: 200, latency: performance.now() - started };
        } catch (caught) {
          const error =
            caught instanceof ApiRequestError ? caught : new ApiRequestError(0, "Network error");
          return { ...probe, status: error.status, latency: performance.now() - started };
        }
      }),
    );
    setMatrix({ kind: "success", data: results });
  };

  return (
    <div className="page-stack">
      <section className="identity-overview" aria-labelledby="identity-overview-title">
        <div className="section-heading identity-heading">
          <div>
            <p className="kicker">Current OAuth session</p>
            <h2 id="identity-overview-title">Who am I?</h2>
          </div>
          <span className="session-state">active</span>
        </div>
        <dl>
          {identityFacts.map(([label, value]) => (
            <div className="identity-fact" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="horizon" aria-labelledby="horizon-title">
        <div>
          <p className="kicker">Live trust boundary</p>
          <h2 id="horizon-title">Revocation horizon</h2>
          <p>One token, three validation strategies, one shared authorization policy.</p>
        </div>
        <fieldset className="horizon-track">
          <legend>Expected revocation behavior</legend>
          <span className="horizon-now">T0</span>
          <div className="horizon-mode">
            <b>Local JWT</b>
            <small>not-before cutoff</small>
          </div>
          <div className="horizon-mode">
            <b>Introspection</b>
            <small>next request</small>
          </div>
          <div className="horizon-mode">
            <b>Cached</b>
            <small>bounded cache</small>
          </div>
        </fieldset>
      </section>

      <section className="evidence-section" aria-labelledby="matrix-title">
        <div className="section-heading">
          <div>
            <h2 id="matrix-title">Authorization decision matrix</h2>
            <p>Run the same identity against each API mode. Refusals remain evidence.</p>
          </div>
          <button className="primary-button" onClick={() => void runMatrix()} type="button">
            Run live matrix
          </button>
        </div>
        <StatusPanel state={matrix} />
        {matrix.kind === "idle" ? (
          <div className="empty-state">No live decisions yet. Run the matrix to collect them.</div>
        ) : null}
        {matrix.kind === "success" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Validation</th>
                  <th>Route</th>
                  <th>Decision</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {matrix.data.map((result) => {
                  const expected = result.route !== "/admin/users" || isAdmin;
                  return (
                    <tr key={`${result.mode}-${result.route}`}>
                      <td>{result.mode}</td>
                      <td>
                        <code>{result.route}</code>
                      </td>
                      <td>
                        <span className={`decision status-${result.status}`}>
                          {result.status || "network"}
                        </span>
                      </td>
                      <td>
                        {result.latency.toFixed(0)} ms
                        {!expected && result.status === 403 ? " · expected refusal" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function TokenInspector({
  accessToken,
  idToken,
}: {
  accessToken: string;
  idToken: string | undefined;
}) {
  const tokens = [
    { name: "ID token", purpose: "Browser sign-in identity", value: idToken },
    { name: "Access token", purpose: "API authorization evidence", value: accessToken },
  ];
  const highlightedClaims = new Set(["iss", "aud", "exp", "scope", "realm_access"]);
  return (
    <section className="page-stack" aria-labelledby="tokens-title">
      <header className="page-heading">
        <p className="kicker">Memory only</p>
        <h2 id="tokens-title">Token inspector</h2>
        <p>
          Claims are decoded for teaching. The API accepts only the access token; the ID token is
          for the browser session. Token strings are never rendered or copied.
        </p>
      </header>
      <div className="token-grid">
        {tokens.map((token) => {
          const header = decodeJwtPart(token.value, 0);
          const claims = decodeJwt(token.value);
          return (
            <article className="token-sheet" key={token.name}>
              <header>
                <div>
                  <h3>{token.name}</h3>
                  <p className="token-purpose">{token.purpose}</p>
                </div>
                <code className="token-fingerprint">{tokenFingerprint(token.value)}</code>
              </header>
              {claims === null ? (
                <div className="empty-state">This token was not issued in the current session.</div>
              ) : (
                <>
                  <div className="token-header">
                    <b>JOSE header</b>
                    <code>{JSON.stringify(header)}</code>
                  </div>
                  <dl className="claim-list">
                    {Object.entries(claims).map(([key, value]) => (
                      <div
                        className={`claim-row${highlightedClaims.has(key) ? " claim-highlight" : ""}`}
                        key={key}
                      >
                        <dt>{key}</dt>
                        <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Documents({ mode, token }: { mode: ValidationMode; token: string }) {
  const [state, setState] = useState<AsyncState<DocumentRecord[]>>({ kind: "loading" });
  const [operation, setOperation] = useState<AsyncState<unknown>>({ kind: "idle" });
  const [selected, setSelected] = useState<DocumentRecord | null>(null);
  const [title, setTitle] = useState("");
  const [lastResult, setLastResult] = useState<ApiResult<unknown> | null>(null);
  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    setSelected(null);
    apiRequestDetailed<{ documents: DocumentRecord[] }>(mode, "/documents", token)
      .then((result) => {
        if (!active) return;
        setLastResult(result);
        setState({ kind: "success", data: result.data.documents });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setState({
          kind: "error",
          error:
            caught instanceof ApiRequestError ? caught : new ApiRequestError(0, "Network error"),
        });
      });
    return () => {
      active = false;
    };
  }, [mode, token]);

  const recordFailure = (caught: unknown) => {
    setOperation({
      kind: "error",
      error: caught instanceof ApiRequestError ? caught : new ApiRequestError(0, "Network error"),
    });
  };

  const viewDocument = async (document: DocumentRecord) => {
    setOperation({ kind: "loading" });
    try {
      const result = await apiRequestDetailed<DocumentRecord>(
        mode,
        `/documents/${document.id}`,
        token,
      );
      setSelected(result.data);
      setLastResult(result);
      setOperation({ kind: "success", data: result.data });
    } catch (caught) {
      recordFailure(caught);
    }
  };

  const createDocument = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() === "") return;
    setOperation({ kind: "loading" });
    try {
      const result = await apiRequestDetailed<DocumentRecord>(mode, "/documents", token, {
        method: "POST",
        body: JSON.stringify({ title: title.trim() }),
      });
      setState((current) =>
        current.kind === "success"
          ? { kind: "success", data: [...current.data, result.data] }
          : current,
      );
      setSelected(result.data);
      setTitle("");
      setLastResult(result);
      setOperation({ kind: "success", data: result.data });
    } catch (caught) {
      recordFailure(caught);
    }
  };

  const deleteDocument = async () => {
    if (selected === null) return;
    setOperation({ kind: "loading" });
    try {
      const result = await apiRequestDetailed<void>(mode, `/documents/${selected.id}`, token, {
        method: "DELETE",
      });
      setState((current) =>
        current.kind === "success"
          ? { kind: "success", data: current.data.filter((item) => item.id !== selected.id) }
          : current,
      );
      setSelected(null);
      setLastResult(result);
      setOperation({ kind: "success", data: null });
    } catch (caught) {
      recordFailure(caught);
    }
  };

  return (
    <section className="page-stack" aria-labelledby="documents-title">
      <header className="page-heading">
        <p className="kicker">Policy-filtered</p>
        <h2 id="documents-title">Documents</h2>
        <p>Managers and administrators see all records. Employees see only their own.</p>
      </header>
      <StatusPanel state={state} />
      <StatusPanel state={operation} />
      <DecisionReceipt result={lastResult} />
      <form className="document-create" onSubmit={(event) => void createDocument(event)}>
        <label htmlFor="document-title">New document title</label>
        <div className="document-create-row">
          <input
            id="document-title"
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Example: Quarterly access review"
            value={title}
          />
          <button className="primary-button" disabled={title.trim() === ""} type="submit">
            Create document
          </button>
        </div>
      </form>
      {state.kind === "success" && state.data.length === 0 ? (
        <div className="empty-state">No documents are visible to this identity.</div>
      ) : null}
      {state.kind === "success" && state.data.length > 0 ? (
        <ul className="document-list">
          {state.data.map((document) => (
            <li key={document.id}>
              <span className="document-id">D{document.id.toString().padStart(3, "0")}</span>
              <div>
                <h3 className="document-title">{document.title}</h3>
                <p className="document-owner">Owner: {document.owner}</p>
              </div>
              <button
                className="quiet-button"
                onClick={() => void viewDocument(document)}
                type="button"
              >
                View
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {selected === null ? null : (
        <aside className="document-detail" aria-label="Selected document">
          <div>
            <span className="document-id">D{selected.id.toString().padStart(3, "0")}</span>
            <h3>{selected.title}</h3>
            <p>Owned by {selected.owner}</p>
          </div>
          <button className="danger-button" onClick={() => void deleteDocument()} type="button">
            Delete document
          </button>
        </aside>
      )}
    </section>
  );
}

function Offboarding() {
  return (
    <section className="page-stack" aria-labelledby="offboarding-title">
      <header className="page-heading">
        <p className="kicker">Experiment preview</p>
        <h2 id="offboarding-title">Offboarding horizon</h2>
        <p>
          The privileged workflow runs from the host CLI. This page explains the evidence without
          placing LDAP, Keycloak administration, or revocation credentials in the browser.
        </p>
      </header>
      <ol className="timeline">
        <li className="ready">
          <b>Disable directory sign-in</b>
          <span className="timeline-detail">LDAP lock and group removal</span>
        </li>
        <li>
          <b>End identity sessions</b>
          <span className="timeline-detail">Keycloak logout and token revocation</span>
        </li>
        <li>
          <b>Publish not-before cutoff</b>
          <span className="timeline-detail">Immediate local-validator refusal</span>
        </li>
        <li>
          <b>Measure residual access</b>
          <span className="timeline-detail">One-second polling across all modes</span>
        </li>
      </ol>
      <button className="primary-button" disabled type="button">
        Privileged workflow · host CLI only
      </button>
    </section>
  );
}

function Admin({
  mode,
  token,
  isAdmin,
}: {
  mode: ValidationMode;
  token: string;
  isAdmin: boolean;
}) {
  const [state, setState] = useState<AsyncState<Array<{ username: string; displayName: string }>>>({
    kind: "idle",
  });
  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    setState({ kind: "loading" });
    apiRequest<{ users: Array<{ username: string; displayName: string }> }>(
      mode,
      "/admin/users",
      token,
    )
      .then((body) => active && setState({ kind: "success", data: body.users }))
      .catch(
        (caught: unknown) =>
          active &&
          setState({
            kind: "error",
            error:
              caught instanceof ApiRequestError ? caught : new ApiRequestError(0, "Network error"),
          }),
      );
    return () => {
      active = false;
    };
  }, [isAdmin, mode, token]);
  if (!isAdmin)
    return (
      <div className="state-panel error" role="alert">
        <strong>Policy refused this page</strong>
        <span>The administrator role is required.</span>
        <code>403</code>
      </div>
    );
  return (
    <section className="page-stack" aria-labelledby="admin-title">
      <header className="page-heading">
        <p className="kicker">Administrator gate</p>
        <h2 id="admin-title">Laboratory identities</h2>
        <p>Only safe display fields leave the API.</p>
      </header>
      <StatusPanel state={state} />
      {state.kind === "success" ? (
        <ul className="identity-list">
          {state.data.map((person) => (
            <li key={person.username}>
              <span>{person.displayName}</span>
              <code className="identity-handle">{person.username}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function SecurityConsole({ auth }: { auth: AuthState }) {
  const [page, setPage] = useState<Page>("dashboard");
  const [mode, setMode] = useState<ValidationMode>("local");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const accessClaims = decodeJwt(auth.user?.access_token);
  const roles = stringArrayClaim(accessClaims, ["realm_access", "roles"]);
  const scopes = spaceDelimitedClaim(accessClaims, "scope");
  const isAdmin = roles.includes("admins") && scopes.includes("admin");
  const visiblePages = (Object.keys(pageLabels) as Page[]).filter(
    (candidate) => candidate !== "admin" || isAdmin,
  );
  const username =
    typeof accessClaims?.preferred_username === "string"
      ? accessClaims.preferred_username
      : "signed-in user";

  if (auth.status === "loading")
    return (
      <main className="entry-screen">
        <div className="entry-mark" aria-hidden="true">
          AH
        </div>
        <p role="status">Validating the authorization response…</p>
      </main>
    );
  if (auth.status !== "authenticated" || auth.user === null) {
    return (
      <main className="entry-screen">
        <div className="entry-mark" aria-hidden="true">
          AH
        </div>
        <p className="kicker">IAM access revocation lab</p>
        <h1>See exactly when access stops.</h1>
        <p className="entry-copy">
          Compare local JWT validation, live introspection, and a bounded cache with the same
          identity and policy.
        </p>
        {auth.error === null ? null : (
          <div className="state-panel error" role="alert">
            {auth.error}
          </div>
        )}
        <button className="primary-button" onClick={() => void auth.login()} type="button">
          Sign in with PKCE
        </button>
        <small>No password or client secret is handled by this application.</small>
      </main>
    );
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="identity-rail">
        <div className="brand">
          <span className="brand-mark">AH</span>
          <div>
            <b>Access Horizon</b>
            <small>Security console</small>
          </div>
        </div>
        <div className="identity-badge">
          <span className="presence" aria-hidden="true" />
          <div>
            <b>{username}</b>
            <small>{roles.join(" · ") || "no realm roles"}</small>
          </div>
        </div>
        <nav aria-label="Console pages">
          {visiblePages.map((candidate) => (
            <button
              aria-current={page === candidate ? "page" : undefined}
              key={candidate}
              onClick={() => setPage(candidate)}
              type="button"
            >
              {pageLabels[candidate]}
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <span>Tokens</span>
          <b>in memory only</b>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <ModeSwitch mode={mode} onChange={setMode} />
          <div className="top-actions">
            <button
              className="quiet-button"
              onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
              type="button"
            >
              {theme === "light" ? "Dark" : "Light"} theme
            </button>
            <button className="quiet-button" onClick={() => void auth.logout()} type="button">
              Revoke and sign out
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {page === "dashboard" ? (
            <Dashboard
              claims={accessClaims}
              hasRefreshToken={auth.user.refresh_token !== undefined}
              isAdmin={isAdmin}
              token={auth.user.access_token}
            />
          ) : null}
          {page === "tokens" ? (
            <TokenInspector accessToken={auth.user.access_token} idToken={auth.user.id_token} />
          ) : null}
          {page === "documents" ? <Documents mode={mode} token={auth.user.access_token} /> : null}
          {page === "offboarding" ? <Offboarding /> : null}
          {page === "admin" ? (
            <Admin isAdmin={isAdmin} mode={mode} token={auth.user.access_token} />
          ) : null}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return <SecurityConsole auth={useAuth()} />;
}
