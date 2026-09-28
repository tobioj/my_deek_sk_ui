import type { MetadataRoute } from "next";

// Lets Chrome / Edge / Safari install this as a standalone app with its own Dock icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DeepSeek Chat",
    short_name: "DeepSeek",
    start_url: "/",
    display: "standalone",
    background_color: "#faf9f6",
    theme_color: "#faf9f6",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
