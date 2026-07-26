import type { UserConfig } from "@kubb/core";
import { pluginClient } from "@kubb/plugin-client";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginReactQuery } from "@kubb/plugin-react-query";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";

const appOpenApiUrl =
  process.env.KUBB_APP_OPENAPI_URL ??
  "http://127.0.0.1:4000/api/marketplace/openapi.json";

const config: UserConfig = {
  root: ".",
  input: {
    path: appOpenApiUrl,
  },
  output: {
    path: "./src/generated",
  },
  plugins: [
    pluginOas(),
    pluginTs({
      output: {
        path: "./types",
        barrelType: "all",
      },
    }),
    pluginZod({
      version: "4",
      output: {
        path: "./zod",
        barrelType: "all",
      },
    }),
    pluginClient({
      importPath: "../../clients/app",
      output: {
        path: "./core",
        barrelType: "all",
      },
    }),
    pluginReactQuery({
      client: {
        importPath: "../../clients/app",
      },
      output: {
        path: "./react",
        barrelType: "all",
      },
    }),
  ],
};

export default config;
