// jsdom ships no bundled types; a minimal ambient declaration is enough for
// the docx/pptx HTML-conversion tests, which only construct a DOM and read it.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string | Buffer, options?: unknown);
    readonly window: Window & typeof globalThis;
    serialize(): string;
  }
}
