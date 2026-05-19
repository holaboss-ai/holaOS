import { useCallback, useEffect, useState } from "react";

export const AUTH_BASE_URL = "";
export const AUTH_SIGN_IN_URL = "";
export const AUTH_PROTOCOL_SCHEME = "ai.holaboss.app";
export const DEFAULT_MODEL_PROXY_BASE_URL = "";
export const DEFAULT_RUNTIME_MODEL = "openai/gpt-5.4";

export interface AuthUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  personalXAccount?: string | null;
  timezone?: string | null;
  invitationVerified?: boolean | null;
  onboardingCompleted?: boolean | null;
  role?: string | null;
  [key: string]: unknown;
}

export interface AuthSession {
  user: AuthUser;
}

interface AuthErrorContext {
  message?: string;
  status: number;
  statusText: string;
  path: string;
}

interface DesktopAuthSessionState {
  data: AuthSession | null;
  isPending: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  requestAuth: () => Promise<void>;
  signOut: () => Promise<void>;
}

function normalizeErrorMessage(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error("Authentication request failed.");
}

function toSession(user: AuthUser | null): AuthSession | null {
  return user ? { user } : null;
}

let cachedAuthUser: AuthUser | null | undefined = undefined;

export function useDesktopAuthSession(): DesktopAuthSessionState {
  const [data, setData] = useState<AuthSession | null>(() =>
    cachedAuthUser === undefined ? null : toSession(cachedAuthUser)
  );
  const [isPending, setIsPending] = useState(cachedAuthUser === undefined);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setIsPending(true);
    try {
      const user = await window.electronAPI.auth.getUser();
      cachedAuthUser = user;
      setData(toSession(user));
      setError(null);
    } catch (nextError) {
      setError(normalizeErrorMessage(nextError));
    } finally {
      setIsPending(false);
    }
  }, []);

  const requestAuth = useCallback(async () => {
    setError(null);
    await window.electronAPI.auth.requestAuth();
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    await window.electronAPI.auth.signOut();
    cachedAuthUser = null;
    setData(null);
    setIsPending(false);
  }, []);

  useEffect(() => {
    if (cachedAuthUser === undefined) {
      void refetch();
    }

    const unsubscribeAuthenticated = window.electronAPI.auth.onAuthenticated((user) => {
      cachedAuthUser = user;
      setData(toSession(user));
      setError(null);
      setIsPending(false);
    });

    const unsubscribeUserUpdated = window.electronAPI.auth.onUserUpdated((user) => {
      cachedAuthUser = user;
      setData(toSession(user));
      setError(null);
      setIsPending(false);
    });

    const unsubscribeAuthError = window.electronAPI.auth.onError((context: AuthErrorContext) => {
      setError(new Error(context.message || `${context.status} ${context.statusText}`.trim() || "Authentication failed."));
      setIsPending(false);
    });

    return () => {
      unsubscribeAuthenticated();
      unsubscribeUserUpdated();
      unsubscribeAuthError();
    };
  }, [refetch]);

  return {
    data,
    isPending,
    error,
    refetch,
    requestAuth,
    signOut
  };
}
