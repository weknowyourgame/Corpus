import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Coding Assistant for Roblox",
  description:
    "Open-source AI coding assistant with deep Roblox Studio integration.",
  icons: {
    icon: "/stud/assets/app_icon.png",
    apple: "/stud/assets/app_icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
