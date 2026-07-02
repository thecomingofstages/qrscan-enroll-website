import type { Metadata } from "next";
import { Sarabun } from "next/font/google";
import "./globals.css";

const sarabun = Sarabun({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sarabun',
  weight: '400'
})

export const metadata: Metadata = {
  title: "QR Reader for Enrollment website",
  description: "",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${ sarabun.variable } h-full antialiased`}>
    <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
