import { defineConfig } from "vitepress";

// Preserve Vite 6's targets except Safari 14, whose destructuring target is
// unsupported by the repository's patched esbuild. Apply to build and dev.
const browserTargets = ["es2020", "chrome87", "edge88", "firefox78", "safari14.1"];

export default defineConfig({
  title: "DialCache",
  description:
    "DialCache organizes caching into use cases, with runtime control and observability for each one. Reference for the read path, runtime policies, and the API.",
  lang: "en-US",
  base: "/DialCache/",
  vite: {
    build: { target: browserTargets },
    optimizeDeps: { esbuildOptions: { target: browserTargets } },
  },
  themeConfig: {
    nav: [
      { text: "Documentation", link: "/" },
      { text: "API reference", link: "/api" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "TypeScript setup", link: "/languages/typescript" },
          { text: "Go setup", link: "/languages/go" },
          { text: "Rust setup", link: "/languages/rust" },
          { text: "Python setup", link: "/languages/python" },
        ],
      },
      {
        text: "Core model",
        items: [
          { text: "How DialCache works", link: "/concepts" },
          { text: "Keys and identity", link: "/keys" },
          { text: "Configuration and rollout", link: "/configuration" },
        ],
      },
      {
        text: "Feature guides",
        items: [
          { text: "Targeted invalidation", link: "/invalidation" },
          { text: "Stale-on-error", link: "/stale-on-error" },
          { text: "Shadow validation", link: "/shadow-validation" },
          { text: "Coalescing and liveness", link: "/coalescing" },
        ],
      },
      {
        text: "Reference and integrations",
        items: [
          { text: "API reference", link: "/api" },
          { text: "Redis and Valkey", link: "/redis" },
          { text: "Observability", link: "/observability" },
          { text: "Behavior catalogue", link: "/generated/behavior" },
        ],
      },
      {
        text: "Maintenance",
        items: [
          { text: "Upgrading", link: "/upgrading" },
          { text: "Maintainer guide", link: "/maintainers" },
          { text: "Writing shared docs", link: "/authoring" },
        ],
      },
    ],
    outline: [2, 3],
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/lan17/DialCache" },
    ],
    editLink: {
      pattern: "https://github.com/lan17/DialCache/edit/main/docs/:path",
    },
  },
});
