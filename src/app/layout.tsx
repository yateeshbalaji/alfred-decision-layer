import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "alfred_ — Execution Decision Layer",
  description:
    "Prototype for deciding whether alfred_ should execute, confirm, ask, or refuse a proposed action.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">
        {children}
      </body>
    </html>
  );
}
