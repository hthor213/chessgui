import "./globals.css"
import { PwaRegister } from "./pwa"

// PWA surface (spec 223): manifest + apple-touch-icon make the deployment
// installable; the viewport pins zoom (user-scalable=no per the spec's
// touch-containment rule — pinch-zoom fights board drags) and opts into
// edge-to-edge rendering so safe-area insets (globals.css) can do their job.
// All paths are written with the /chess basePath explicitly — Next does not
// prefix metadata URLs.
export const metadata = {
  title: "ChessGUI",
  manifest: "/chess/manifest.webmanifest",
  icons: {
    apple: "/chess/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent" as const,
    title: "ChessGUI",
  },
}

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover" as const,
  themeColor: "#0a0a0a",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      {/* h-dvh (not h-screen): on mobile Safari 100vh includes the collapsed
          URL bar, pushing the bottom of the app under it; dvh tracks the
          real visible height. Identical to 100vh in desktop browsers. */}
      <body className="bg-[#0a0a0a] text-[#f6f6f6] h-dvh overflow-hidden"
        style={{
          backgroundImage: "radial-gradient(ellipse at 50% 40%, rgba(50,50,50,0.3) 0%, transparent 70%)",
        }}
      >
        <PwaRegister />
        {children}
      </body>
    </html>
  )
}
