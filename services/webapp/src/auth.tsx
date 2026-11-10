import {
  InMemoryWebStorage,
  type User,
  UserManager,
  type UserManagerSettings,
  WebStorageStateStore,
} from "oidc-client-ts";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type AuthState = {
  status: "loading" | "anonymous" | "authenticated" | "error";
  user: User | null;
  error: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function createUserManager(origin = window.location.origin): UserManager {
  const settings: UserManagerSettings = {
    authority: "https://auth.localhost/realms/company",
    client_id: "webapp",
    redirect_uri: `${origin}/callback`,
    post_logout_redirect_uri: origin,
    response_type: "code",
    scope: "openid docs:read docs:write admin",
    loadUserInfo: false,
    automaticSilentRenew: true,
    monitorSession: false,
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  };
  return new UserManager(settings);
}

export function AuthProvider({
  children,
  manager: providedManager,
}: {
  children: ReactNode;
  manager?: UserManager;
}) {
  const [manager] = useState(() => providedManager ?? createUserManager());
  const callbackPromise = useRef<Promise<User> | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const handleUserLoaded = (loaded: User) => {
      if (!active) return;
      setUser(loaded);
      setStatus("authenticated");
    };
    const handleUserUnloaded = () => {
      if (!active) return;
      setUser(null);
      setStatus("anonymous");
    };
    manager.events.addUserLoaded(handleUserLoaded);
    manager.events.addUserUnloaded(handleUserUnloaded);
    const finish = async () => {
      try {
        if (window.location.pathname === "/callback" && callbackPromise.current === null) {
          callbackPromise.current = manager.signinRedirectCallback();
        }
        const resolved = await (callbackPromise.current ?? manager.getUser());
        if (!active) return;
        if (window.location.pathname === "/callback") window.history.replaceState({}, "", "/");
        setUser(resolved);
        setStatus(resolved === null ? "anonymous" : "authenticated");
      } catch (caught) {
        if (!active) return;
        setError(
          caught instanceof Error ? caught.message : "The sign-in response could not be processed.",
        );
        setStatus("error");
      }
    };
    void finish();
    return () => {
      active = false;
      manager.events.removeUserLoaded(handleUserLoaded);
      manager.events.removeUserUnloaded(handleUserUnloaded);
    };
  }, [manager]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      error,
      login: async () => {
        setError(null);
        await manager.signinRedirect();
      },
      logout: async () => {
        setError(null);
        try {
          if (user !== null) await manager.revokeTokens(["access_token", "refresh_token"]);
        } catch {
          setError("Token revocation could not be confirmed; the local session was still cleared.");
        }
        await manager.removeUser();
        setUser(null);
        setStatus("anonymous");
        try {
          await manager.signoutRedirect({
            ...(user?.id_token === undefined ? {} : { id_token_hint: user.id_token }),
          });
        } catch {
          setError("Keycloak logout could not be reached; the local session was still cleared.");
        }
      },
    }),
    [error, manager, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (state === null) throw new Error("useAuth must be used inside AuthProvider");
  return state;
}
