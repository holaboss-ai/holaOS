const OVERLAY_ID = "holaboss-browser-popup-loading-overlay";
const STYLE_ID = "holaboss-browser-popup-loading-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    :root {
      color-scheme: dark;
    }

    html, body {
      background: #050907 !important;
    }

    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(40, 92, 73, 0.24), transparent 48%),
        rgba(5, 9, 7, 0.78);
      opacity: 0;
      transition: opacity 140ms ease;
      pointer-events: none;
    }

    #${OVERLAY_ID}[data-visible="true"] {
      opacity: 1;
    }

    #${OVERLAY_ID} .panel {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      padding: 10px 14px;
      background: rgba(11, 15, 13, 0.84);
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.32);
      color: rgba(247, 250, 248, 0.94);
      font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: -0.01em;
      backdrop-filter: blur(12px);
    }

    #${OVERLAY_ID} .spinner {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.18);
      border-top-color: rgba(123, 255, 194, 0.95);
      animation: holaboss-browser-popup-spin 720ms linear infinite;
    }

    @keyframes holaboss-browser-popup-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function ensureOverlay() {
  ensureStyle();
  if (document.getElementById(OVERLAY_ID)) {
    return;
  }
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.dataset.visible = "true";
  overlay.innerHTML =
    '<div class="panel"><div class="spinner"></div><div>Loading page...</div></div>';
  const parent = document.body || document.documentElement;
  if (!parent) {
    window.requestAnimationFrame(ensureOverlay);
    return;
  }
  parent.appendChild(overlay);
}

function hideOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    return;
  }
  overlay.dataset.visible = "false";
  window.setTimeout(() => {
    overlay.remove();
  }, 180);
}

if (document.readyState !== "complete") {
  ensureOverlay();
}

window.addEventListener("DOMContentLoaded", ensureOverlay, { once: true });
window.addEventListener("beforeunload", ensureOverlay);
window.addEventListener("load", hideOverlay, { once: true });
document.addEventListener("readystatechange", () => {
  if (document.readyState === "complete") {
    hideOverlay();
  } else {
    ensureOverlay();
  }
});
