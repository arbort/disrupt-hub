import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://disrupt-hub.ru",
  output: "static",
  integrations: [sitemap()],
});
