import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["server/src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/server/index.js",
  sourcemap: true,
  minify: false,
  // The server only uses node: builtins — no external runtime deps needed
  external: [],
});
