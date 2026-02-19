import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { mkdirSync, copyFileSync } from "fs";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle:      true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format:      "cjs",
  target:      "es2018",
  logLevel:    "info",
  sourcemap:   prod ? false : "inline",
  treeShaking: true,
  outfile:     "doodle/main.js",
});

function copyAssets() {
  mkdirSync("doodle", { recursive: true });
  copyFileSync("manifest.json", "doodle/manifest.json");
  copyFileSync("src/styles.css", "doodle/styles.css");
}

if (prod) {
  await context.rebuild();
  copyAssets();
  console.log("Build output → doodle/  (copy this folder to .obsidian/plugins/doodle/)");
  process.exit(0);
} else {
  copyAssets();
  await context.watch();
}
