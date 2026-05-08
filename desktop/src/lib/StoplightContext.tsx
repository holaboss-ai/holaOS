/**
 * StoplightContext — opt-in macOS traffic-light compensation.
 *
 * macOS frameless windows render the close/min/max buttons (the
 * "stoplight") at fixed coordinates inside the window. Header
 * content placed at left:0 collides with them. We solve this by
 * letting the leftmost panel header reserve a left-pad equal to
 * STOPLIGHT_PAD_PX, but only when:
 *   1. the platform is macOS, and
 *   2. a parent has explicitly opted in via <StoplightProvider value={true}>
 *
 * Why context, not a constant: in multi-panel layouts only the
 * leftmost panel needs the pad. Every other panel sits beside or
 * to the right of the stoplights and should render at its natural
 * left edge. Wrapping the leftmost panel in <StoplightProvider>
 * lets every PanelHeader inside ask the hook without prop-drilling.
 *
 * Usage:
 *   <StoplightProvider value={isLeftmostPanel}>
 *     <PanelHeader />     // calls useStoplightCompensation()
 *   </StoplightProvider>
 *
 *   function PanelHeader() {
 *     const compensate = useStoplightCompensation()
 *     return <div style={{ paddingLeft: compensate ? STOPLIGHT_PAD_PX : 16 }} />
 *   }
 */

import { createContext, useContext, type ReactNode } from "react"

/**
 * Pixels to reserve at the left edge for macOS traffic lights.
 * Empirically tuned for Electron 30+ on macOS 14+. Slightly less
 * than the craft-agents value to stay tight against the right-most
 * stoplight glyph without crowding it.
 */
export const STOPLIGHT_PAD_PX = 60

const StoplightContext = createContext<boolean>(false)

interface StoplightProviderProps {
  /** Set true on the leftmost panel only. */
  value: boolean
  children: ReactNode
}

export function StoplightProvider({ value, children }: StoplightProviderProps) {
  return (
    <StoplightContext.Provider value={value}>
      {children}
    </StoplightContext.Provider>
  )
}

/**
 * Returns true when the current subtree should reserve space for
 * macOS traffic lights. False on non-macOS platforms regardless of
 * provider value, so call sites don't need to platform-check.
 */
export function useStoplightCompensation(): boolean {
  const flag = useContext(StoplightContext)
  if (!flag) return false
  return window.electronAPI?.platform === "darwin"
}
