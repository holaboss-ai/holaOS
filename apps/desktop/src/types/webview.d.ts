import type React from "react";

declare global {
  interface AppWebViewElement extends HTMLElement {
    src: string;
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    reload(): void;
    loadURL(url: string): void;
    getURL(): string;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<AppWebViewElement>, AppWebViewElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
      };
    }
  }
}

export {};