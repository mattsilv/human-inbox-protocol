import { defineConfig } from "astro/config";

// Static marketing site for HIP — the agent↔human interaction protocol.
// Output is a fully static bundle (site/dist/) with no runtime, no external
// network calls (no font CDN), portable to any host. Set `site` once a URL
// is chosen.
export default defineConfig({
  output: "static",
  // site: "https://hip.example", // TODO: set once the host/domain is chosen
  build: { inlineStylesheets: "auto" },
});
