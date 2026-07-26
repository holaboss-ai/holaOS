import { atom } from "jotai";

// The HolaEmployee + thread currently open in the dedicated Employees chat pane.
// null = no employee selected (the normal ChatPanel is shown). threadId is the
// client-stable conversation id (a fresh uuid starts a new chat).
export interface SelectedEmployee {
  employeeId: string;
  name: string;
  threadId: string;
  /** True when this is a freshly-started chat (no server history to load) — lets
   *  the pane skip the history spinner and show the empty compose state at once. */
  isNew?: boolean;
}

export const selectedEmployeeAtom = atom<SelectedEmployee | null>(null);
