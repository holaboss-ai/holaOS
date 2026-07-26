export function DiagramWorkspaceTree() {
  return (
    <div className="hb-diagram-tree">
      <ul className="hb-tree">
        <li className="hb-tree__item hb-tree__item--root">
          <div className="hb-tree__node hb-tree__node--template">
            <span className="hb-tree__label">Template</span>
            <span className="hb-tree__meta">provisioning source</span>
          </div>
          <ul>
            <li className="hb-tree__item">
              <div className="hb-tree__node hb-tree__node--workspace">
                <span className="hb-tree__label">Workspace</span>
                <span className="hb-tree__meta">unit of work</span>
              </div>
              <ul>
                <li className="hb-tree__item">
                  <div className="hb-tree__node hb-tree__node--skill">
                    <span className="hb-tree__label">Skills</span>
                    <span className="hb-tree__meta">instruction packs</span>
                  </div>
                </li>
                <li className="hb-tree__item">
                  <div className="hb-tree__node hb-tree__node--leaf">
                    <span className="hb-tree__label">Workspace Commands</span>
                    <span className="hb-tree__meta">
                      explicit runnable capabilities
                    </span>
                  </div>
                </li>
                <li className="hb-tree__item">
                  <div className="hb-tree__node hb-tree__node--app">
                    <span className="hb-tree__label">Apps</span>
                    <span className="hb-tree__meta">
                      capability modules — code-based
                    </span>
                  </div>
                  <ul>
                    <li className="hb-tree__item">
                      <div className="hb-tree__node hb-tree__node--leaf">
                        <span className="hb-tree__label">MCP Tools</span>
                        <span className="hb-tree__meta">
                          what the runtime can project
                        </span>
                      </div>
                    </li>
                    <li className="hb-tree__item">
                      <div className="hb-tree__node hb-tree__node--leaf">
                        <span className="hb-tree__label">Web UI</span>
                        <span className="hb-tree__meta">
                          what the user can see
                        </span>
                      </div>
                    </li>
                    <li className="hb-tree__item">
                      <div className="hb-tree__node hb-tree__node--integration">
                        <span className="hb-tree__label">
                          Integration Requirements
                        </span>
                        <span className="hb-tree__meta">
                          what credentials it needs
                        </span>
                      </div>
                      <ul>
                        <li className="hb-tree__item">
                          <div className="hb-tree__node hb-tree__node--leaf">
                            <span className="hb-tree__label">Bindings</span>
                            <span className="hb-tree__meta">
                              which account serves which app
                            </span>
                          </div>
                        </li>
                        <li className="hb-tree__item">
                          <div className="hb-tree__node hb-tree__node--leaf">
                            <span className="hb-tree__label">Connections</span>
                            <span className="hb-tree__meta">
                              authenticated external accounts
                            </span>
                          </div>
                        </li>
                      </ul>
                    </li>
                  </ul>
                </li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  );
}
