import type { Metadata } from "next";
import { Cairo, Tajawal } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { SessionProvider } from "next-auth/react";
import { CookieConsentBanner } from "@/components/legal/cookie-consent-banner";
import { GoogleAnalytics } from "@/components/analytics/google-analytics";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { ChatbotWidget } from "@/components/chatbot/chatbot-widget";
import { ThemeProvider } from "@/components/theme-provider";
import { initSentry } from "@/lib/services/sentry";

// Initialize Sentry error tracking for both server and client side
initSentry().catch((err) => console.warn("[sentry] initialization failed:", err));

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  display: "swap",
});

const tajawal = Tajawal({
  variable: "--font-tajawal",
  weight: ["300", "400", "500", "700", "800"],
  subsets: ["arabic", "latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXTAUTH_URL || "https://taswerak.com"),
  title: {
    default: "تصويرك | Taswerak — تعلّم التصوير الفوتوغرافي",
    template: "%s | تصويرك",
  },
  description:
    "منصة تصويرك لتعلّم التصوير الفوتوغرافي من الصفر للاحتراف — جدة، السعودية. دورات في أساسيات التصوير، تصوير البيوتي، وميكب توتوريال مع نقد تفصيلي وشهادات موثّقة.",
  keywords: [
    "تصويرك",
    "Taswerak",
    "تصوير فوتوغرافي",
    "دورات تصوير",
    "جدة",
    "تصوير البيوتي",
    "ميكب توتوريال",
    "أحمد زغلول",
    "تعلم التصوير",
    "Photography courses Saudi Arabia",
  ],
  authors: [{ name: "Ahmed Zaghloul" }],
  creator: "Ahmed Zaghloul",
  publisher: "Taswerak",
  icons: {
    icon: "/logo.webp",
    apple: "/logo.webp",
  },
  manifest: "/manifest.json",
  alternates: {
    canonical: "/",
    languages: { "ar-SA": "/" },
  },
  openGraph: {
    title: "تصويرك | Taswerak — تعلّم التصوير الفوتوغرافي",
    description: "دورات تصوير فوتوغرافي احترافية مع نقد تفصيلي وشهادات موثّقة — جدة، السعودية",
    siteName: "تصويرك",
    type: "website",
    locale: "ar_SA",
    url: "/",
    images: [
      {
        url: "/logo.webp",
        width: 240,
        height: 64,
        alt: "تصويرك — Taswerak",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "تصويرك | Taswerak",
    description: "تعلّم التصوير الفوتوغرافي من الصفر للاحتراف",
    images: ["/logo.webp"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body
        className={`${cairo.variable} ${tajawal.variable} antialiased bg-background text-foreground font-tajawal`}
        style={{ fontFamily: "var(--font-tajawal), system-ui, sans-serif" }}
      >
        <SessionProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </SessionProvider>
        <CookieConsentBanner />
        <GoogleAnalytics />
        <ServiceWorkerRegister />
        <ChatbotWidget />
        <Toaster />
        <SonnerToaster position="top-center" dir="rtl" />
      </body>
    </html>
  );
}
