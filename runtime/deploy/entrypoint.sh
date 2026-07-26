#!/usr/bin/env bash
set -euo pipefail

source /opt/holaboss-runtime/bootstrap/shared.sh
source /opt/holaboss-runtime/bootstrap/container.sh

holaboss_container_bootstrap
holaboss_runtime_shared_main "$@"
