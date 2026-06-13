import { defineConfig } from "astro/config";

// Static marketing site for HIP — the agent↔human interaction protocol.
// Output is a fully static bundle (site/dist/) with no runtime, no external
// network calls (no font CDN), portable to any host. Set `site` once a URL
// is chosen.
export default defineConfig({
  output: "static",
  // GitHub Pages project site: served under the /human-inbox-protocol/ subpath.
  site: "https://mattsilv.github.io",
  base: "/human-inbox-protocol/",
  build: { inlineStylesheets: "auto" },
});
