import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Churn AI · Tigo",
  description: "Investigación de reclamos y propuestas de atención con evidencia",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
