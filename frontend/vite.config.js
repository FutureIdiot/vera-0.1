import { defineConfig, loadEnv } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, frontendRoot, "");
  const gatewayHost = env.VERA_GATEWAY_HOST || "127.0.0.1";
  const gatewayPort = env.VERA_GATEWAY_PORT || process.env.PORT || "3210";
  const gatewayTarget = env.VERA_GATEWAY_URL || `http://${gatewayHost}:${gatewayPort}`;

  return {
    root: frontendRoot,
    build: {
      outDir: resolve(frontendRoot, "dist"),
      emptyOutDir: true,
      manifest: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("/src/platform/")) return "platform-web";
            return undefined;
          },
        },
      },
    },
    server: {
      headers: {
        "Cache-Control": "no-store",
      },
      proxy: {
        "/api": {
          target: gatewayTarget,
          changeOrigin: false,
          proxyTimeout: 0,
          timeout: 0,
        },
      },
    },
  };
});
