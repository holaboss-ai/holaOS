export function DiagramSystemOverview() {
  return (
    <div className="hb-diagram-system">
      <div className="hb-diagram-system__shell">
        <section className="hb-diagram-system__surface">
          <div className="hb-diagram-system__eyebrow">Product Surface</div>
          <div className="hb-diagram-system__title">holaOS Desktop</div>
          <p className="hb-diagram-system__copy">
            Operator shell for opening workspaces, configuring models, inspecting
            state, and launching the runtime.
          </p>
        </section>

        <div aria-hidden="true" className="hb-diagram-system__arrow">
          ↓
        </div>

        <section className="hb-diagram-system__os">
          <div className="hb-diagram-system__os-header">
            <span className="hb-diagram-system__badge">holaOS</span>
            <p className="hb-diagram-system__os-copy">
              Environment layer = workspace contract + runtime services +
              harness boundary
            </p>
          </div>

          <div className="hb-diagram-system__grid">
            <article className="hb-diagram-system__card">
              <div className="hb-diagram-system__eyebrow">
                Workspace Contract
              </div>
              <div className="hb-diagram-system__title">Workspace</div>
              <div className="hb-diagram-system__chips">
                <span className="hb-diagram-system__chip">workspace.yaml</span>
                <span className="hb-diagram-system__chip">AGENTS.md</span>
                <span className="hb-diagram-system__chip">Commands</span>
                <span className="hb-diagram-system__chip">Apps</span>
                <span className="hb-diagram-system__chip">Skills</span>
              </div>
              <p className="hb-diagram-system__copy">
                The authored environment surface the runtime reads and compiles
                per run after workspace creation.
              </p>
            </article>

            <article className="hb-diagram-system__card hb-diagram-system__card--runtime">
              <div className="hb-diagram-system__eyebrow">
                Runtime Services
              </div>
              <div className="hb-diagram-system__title">Runtime</div>
              <div className="hb-diagram-system__chips">
                <span className="hb-diagram-system__chip">API Server</span>
                <span className="hb-diagram-system__chip">Memory</span>
                <span className="hb-diagram-system__chip">State Store</span>
                <span className="hb-diagram-system__chip">Continuity</span>
                <span className="hb-diagram-system__chip">
                  App Orchestration
                </span>
                <span className="hb-diagram-system__chip">
                  Capability Projection
                </span>
              </div>
              <p className="hb-diagram-system__copy">
                Owns memory, continuity, and the execution environment around
                the run, then prepares the reduced package the harness receives.
              </p>

              <div className="hb-diagram-system__subcard">
                <div className="hb-diagram-system__sub-eyebrow">
                  Execution Boundary
                </div>
                <div className="hb-diagram-system__flow">
                  <span className="hb-diagram-system__flow-node">
                    Harness Host
                  </span>
                  <span className="hb-diagram-system__flow-arrow">→</span>
                  <span className="hb-diagram-system__flow-node">
                    Agent Harness
                  </span>
                </div>
                <p className="hb-diagram-system__subcopy">
                  The selected harness runs inside the runtime path, not beside
                  the workspace or desktop.
                </p>
              </div>
            </article>
          </div>

          <p className="hb-diagram-system__footer">
            The runtime compiles the workspace contract into a reduced execution
            package, then hands that package to the selected harness.
          </p>
        </section>
      </div>
    </div>
  );
}
