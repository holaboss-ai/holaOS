import interUrl from "@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2?url";
import geistMonoUrl from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url";
import QRCode from "qrcode";
import type { CardAssets } from "./cards";

let fontCssPromise: Promise<string> | null = null;

async function dataUrl(url: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:font/woff2;base64,${btoa(binary)}`;
}

/** Cards render from a temp file in an offscreen window, so fonts travel inside the HTML. */
function cardFontCss(): Promise<string> {
  fontCssPromise ??= Promise.all([dataUrl(interUrl), dataUrl(geistMonoUrl)])
    .then(
      ([sans, mono]) =>
        `@font-face{font-family:"Card Sans";src:url(${sans}) format("woff2");font-weight:100 900;}` +
        `@font-face{font-family:"Card Mono";src:url(${mono}) format("woff2");font-weight:100 900;}`,
    )
    .catch(() => "");
  return fontCssPromise;
}

export async function cardAssets(url: string): Promise<CardAssets> {
  const [fontCss, qrSvg] = await Promise.all([
    cardFontCss(),
    url
      ? QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1c1815", light: "#0000" } }).catch(() => "")
      : Promise.resolve(""),
  ]);
  return { url, fontCss, qrSvg };
}
