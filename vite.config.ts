import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        protocol: "src/protocol.ts"
      },
      name: "QuackProtocolSDK",
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"]
    },
    sourcemap: false,
    target: "es2022"
  }
});
