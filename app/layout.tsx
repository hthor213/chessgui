import "./globals.css"

export const metadata = {
  title: "ChessGUI",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0a] text-[#f6f6f6] h-screen overflow-hidden"
        style={{
          backgroundImage: "radial-gradient(ellipse at 50% 40%, rgba(50,50,50,0.3) 0%, transparent 70%)",
        }}
      >
        {children}
      </body>
    </html>
  )
}
