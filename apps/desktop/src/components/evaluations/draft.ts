import { useCallback, useEffect, useRef, useState } from "react";

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// Server refreshes replace the buffer only while it has no local edits.
export function useServerDraft<T>(server: T) {
  const [draft, setDraft] = useState<T>(server);
  const [base, setBase] = useState<T>(server);
  const [changedWhileEditing, setChangedWhileEditing] = useState(false);
  const baseRef = useRef(server);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const serverKey = serialize(server);
  useEffect(() => {
    if (serialize(baseRef.current) === serverKey) {
      return;
    }
    const clean = serialize(draftRef.current) === serialize(baseRef.current);
    baseRef.current = server;
    setBase(server);
    if (clean) {
      setDraft(server);
    } else {
      setChangedWhileEditing(true);
    }
  }, [serverKey]);

  const dirty = serialize(draft) !== serialize(base);

  const discard = useCallback(() => {
    setDraft(baseRef.current);
    setChangedWhileEditing(false);
  }, []);

  const markSaved = useCallback((saved: T) => {
    baseRef.current = saved;
    setBase(saved);
    setDraft(saved);
    setChangedWhileEditing(false);
  }, []);

  return {
    draft,
    setDraft,
    dirty,
    discard,
    markSaved,
    changedWhileEditing: dirty && changedWhileEditing,
  };
}
