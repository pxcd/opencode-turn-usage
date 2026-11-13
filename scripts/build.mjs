import { build as vite } from "vite";
import { build } from "esbuild";
await vite();
await build({ entryPoints: ["src/accounting.ts", "src/tui.ts"], outdir: "dist", bundle: true, format: "esm", target: "es2022", packages: "external" });
