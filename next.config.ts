import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'images-na.ssl-images-amazon.com' },
      { protocol: 'https', hostname: 'm.media-amazon.com' },
    ],
  },
  // Next 15+ blocks RSC/HMR requests from non-localhost dev origins unless
  // they're listed here. Wildcard covers any LAN IP so phones on the same
  // Wi-Fi can also load the dev build.
  allowedDevOrigins: [
    '10.0.0.7',
    '*.local',
    '192.168.*.*',
    '10.*.*.*',
    '*.ngrok-free.app',
    '*.ngrok.app',
    '*.ngrok.io',
    '*.trycloudflare.com',
  ],
};

export default nextConfig;
